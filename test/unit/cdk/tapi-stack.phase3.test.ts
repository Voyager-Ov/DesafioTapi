import * as cdk from 'aws-cdk-lib';
import { TapiStack } from '../../../cdk/lib/stacks/tapi-stack';

describe('TapiStack phase 3 foundations', () => {
  it('adds dispatch-slot-index to pending records with the expected keys', () => {
    const app = new cdk.App();
    const stack = new TapiStack(app, 'TestTapiStackPhase3', {
      env: {
        account: '123456789012',
        region: 'us-east-1',
      },
    });

    const assembly = app.synth();
    const template = assembly.getStackArtifact(stack.artifactId).template as {
      Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }>;
    };

    const pendingTable = Object.values(template.Resources).find(
      (resource) =>
        resource.Type === 'AWS::DynamoDB::Table'
        && resource.Properties?.TableName === 'tapi-pending-records',
    );

    expect(pendingTable).toBeDefined();

    const gsis = (pendingTable?.Properties?.GlobalSecondaryIndexes as Array<Record<string, unknown>>) ?? [];
    const dispatchSlotIndex = gsis.find((gsi) => gsi.IndexName === 'dispatch-slot-index');

    expect(dispatchSlotIndex).toBeDefined();
    expect(dispatchSlotIndex).toMatchObject({
      IndexName: 'dispatch-slot-index',
      Projection: { ProjectionType: 'ALL' },
      KeySchema: [
        { AttributeName: 'dispatchSlotPk', KeyType: 'HASH' },
        { AttributeName: 'dispatchSortKey', KeyType: 'RANGE' },
      ],
    });
  });

  it('grants the producer only query access to the dispatch index and send access to SQS', () => {
    const app = new cdk.App();
    const stack = new TapiStack(app, 'TestTapiStackPhase3Iam', {
      env: {
        account: '123456789012',
        region: 'us-east-1',
      },
    });

    const assembly = app.synth();
    const template = assembly.getStackArtifact(stack.artifactId).template as {
      Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }>;
    };

    const policies = Object.values(template.Resources).filter(
      (resource) => resource.Type === 'AWS::IAM::Policy',
    );
    const producerPolicy = policies.find((resource) =>
      JSON.stringify(resource.Properties?.PolicyName ?? '').includes('ProducerFunctionServiceRoleDefaultPolicy'),
    );

    expect(producerPolicy).toBeDefined();

    const statements = ((producerPolicy?.Properties?.PolicyDocument as { Statement: Array<Record<string, unknown>> }).Statement);
    const policyJson = JSON.stringify(statements);

    expect(policyJson).toContain('dynamodb:Query');
    expect(policyJson).toContain('dynamodb:DescribeTable');
    expect(policyJson).not.toContain('dynamodb:Scan');
    expect(policyJson).not.toContain('dynamodb:GetItem');
    expect(policyJson).toContain('/index/dispatch-slot-index');
    expect(policyJson).toContain('sqs:SendMessage');
  });

  it('configures the provider queue for FIFO High Throughput', () => {
    const app = new cdk.App();
    const stack = new TapiStack(app, 'TestTapiStackPhase3Queue', {
      env: {
        account: '123456789012',
        region: 'us-east-1',
      },
    });

    const assembly = app.synth();
    const template = assembly.getStackArtifact(stack.artifactId).template as {
      Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }>;
    };

    const providerQueue = Object.values(template.Resources).find(
      (resource) =>
        resource.Type === 'AWS::SQS::Queue'
        && resource.Properties?.QueueName === 'tapi-provider-queue.fifo',
    );

    expect(providerQueue).toBeDefined();
    expect(providerQueue?.Properties).toMatchObject({
      FifoQueue: true,
      DeduplicationScope: 'messageGroup',
      FifoThroughputLimit: 'perMessageGroupId',
    });
  });

  it('creates 288 distributed EventBridge schedules with slot payloads', () => {
    const app = new cdk.App();
    const stack = new TapiStack(app, 'TestTapiStackPhase3Schedules', {
      env: {
        account: '123456789012',
        region: 'us-east-1',
      },
    });

    const assembly = app.synth();
    const template = assembly.getStackArtifact(stack.artifactId).template as {
      Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }>;
    };

    const schedules = Object.values(template.Resources).filter(
      (resource) => resource.Type === 'AWS::Scheduler::Schedule',
    );
    const schedulerDlq = Object.values(template.Resources).find(
      (resource) =>
        resource.Type === 'AWS::SQS::Queue'
        && resource.Properties?.QueueName === 'tapi-scheduler-dlq',
    );

    expect(schedules).toHaveLength(288);
    expect(schedulerDlq).toBeDefined();

    const firstSchedule = schedules.find(
      (resource) => resource.Properties?.Name === 'tapi-dispatch-slot-000',
    );
    const lastSchedule = schedules.find(
      (resource) => resource.Properties?.Name === 'tapi-dispatch-slot-287',
    );

    expect(firstSchedule?.Properties).toMatchObject({
      ScheduleExpression: 'cron(0 0 * * ? *)',
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
    });
    expect(lastSchedule?.Properties).toMatchObject({
      ScheduleExpression: 'cron(55 23 * * ? *)',
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
    });

    expect(firstSchedule?.Properties?.Target).toMatchObject({
      Input: JSON.stringify({
        source: 'tapi.distributed-dispatch',
        slotId: 0,
        slotsPerDay: 288,
        targetDateStrategy: 'today-utc-by-default',
      }),
      RetryPolicy: {
        MaximumEventAgeInSeconds: 3600,
        MaximumRetryAttempts: 3,
      },
      DeadLetterConfig: expect.any(Object),
    });
    expect(lastSchedule?.Properties?.Target).toMatchObject({
      Input: JSON.stringify({
        source: 'tapi.distributed-dispatch',
        slotId: 287,
        slotsPerDay: 288,
        targetDateStrategy: 'today-utc-by-default',
      }),
      RetryPolicy: {
        MaximumEventAgeInSeconds: 3600,
        MaximumRetryAttempts: 3,
      },
      DeadLetterConfig: expect.any(Object),
    });
    expect(firstSchedule?.Properties?.Target).toHaveProperty('DeadLetterConfig.Arn');
    expect(lastSchedule?.Properties?.Target).toHaveProperty('DeadLetterConfig.Arn');
  });

  it('grants the scheduler role permission to invoke the producer and send messages to the scheduler DLQ', () => {
    const app = new cdk.App();
    const stack = new TapiStack(app, 'TestTapiStackPhase3SchedulerIam', {
      env: {
        account: '123456789012',
        region: 'us-east-1',
      },
    });

    const assembly = app.synth();
    const template = assembly.getStackArtifact(stack.artifactId).template as {
      Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }>;
    };

    const policies = Object.values(template.Resources).filter(
      (resource) => resource.Type === 'AWS::IAM::Policy',
    );
    const schedulerPolicy = policies.find((resource) =>
      JSON.stringify(resource.Properties?.PolicyName ?? '').includes('TapiSchedulerRoleDefaultPolicy'),
    );

    expect(schedulerPolicy).toBeDefined();

    const policyJson = JSON.stringify(
      (schedulerPolicy?.Properties?.PolicyDocument as { Statement: Array<Record<string, unknown>> }).Statement,
    );

    expect(policyJson).toContain('lambda:InvokeFunction');
    expect(policyJson).toContain('sqs:SendMessage');
    expect(policyJson).toContain('TapiSchedulerDLQ');
  });

  it('replaces the SQS-consuming orchestrator with an EventBridge Pipe into Step Functions', () => {
    const app = new cdk.App();
    const stack = new TapiStack(app, 'TestTapiStackPhase3Pipe', {
      env: {
        account: '123456789012',
        region: 'us-east-1',
      },
    });

    const assembly = app.synth();
    const template = assembly.getStackArtifact(stack.artifactId).template as {
      Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }>;
    };

    const pipe = Object.values(template.Resources).find(
      (resource) => resource.Type === 'AWS::Pipes::Pipe',
    );
    expect(pipe).toBeDefined();
    expect(pipe?.Properties).toMatchObject({
      Name: 'tapi-provider-pipe',
      DesiredState: 'RUNNING',
      SourceParameters: {
        SqsQueueParameters: {
          BatchSize: 1,
        },
      },
      TargetParameters: {
        StepFunctionStateMachineParameters: {
          InvocationType: 'REQUEST_RESPONSE',
        },
      },
    });

    const eventSourceMappings = Object.values(template.Resources).filter(
      (resource) => resource.Type === 'AWS::Lambda::EventSourceMapping',
    );
    expect(eventSourceMappings).toHaveLength(0);
  });
});
