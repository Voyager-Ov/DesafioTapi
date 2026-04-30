import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as path from 'path';

const TTL_DAYS = 90;

export class TapiStack extends cdk.Stack {
  public readonly resultsTable: dynamodb.Table;
  public readonly pendingRecordsTable: dynamodb.Table;
  public readonly providerQueue: sqs.Queue;
  public readonly consumerFunction?: lambda.Function;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.resultsTable = new dynamodb.Table(this, 'TapiResultsTable', {
      tableName: 'tapi-results',
      partitionKey: {
        name: 'PK',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'SK',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    this.pendingRecordsTable = new dynamodb.Table(this, 'TapiPendingRecordsTable', {
      tableName: 'tapi-pending-records',
      partitionKey: {
        name: 'PK',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'SK',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    this.pendingRecordsTable.addGlobalSecondaryIndex({
      indexName: 'provider-date-index',
      partitionKey: {
        name: 'providerId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'PK',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const providerDlq = new sqs.Queue(this, 'TapiProviderDLQ', {
      queueName: 'tapi-provider-dlq.fifo',
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    this.providerQueue = new sqs.Queue(this, 'TapiProviderQueue', {
      queueName: 'tapi-provider-queue.fifo',
      fifo: true,
      contentBasedDeduplication: false,
      visibilityTimeout: cdk.Duration.minutes(2),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: {
        queue: providerDlq,
        maxReceiveCount: 3,
      },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    const producerLogGroup = new logs.LogGroup(this, 'TapiProducerLogGroup', {
      logGroupName: '/aws/lambda/tapi-producer',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const producerFn = new NodejsFunction(this, 'TapiProducerFunction', {
      functionName: 'tapi-producer',
      entry: path.join(__dirname, '../../../src/functions/producer/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      logGroup: producerLogGroup,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        SQS_QUEUE_URL: this.providerQueue.queueUrl,
        PENDING_RECORDS_TABLE: this.pendingRecordsTable.tableName,
        TTL_DAYS: String(TTL_DAYS),
        LOG_LEVEL: 'INFO',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: [],
        target: 'node20',
      },
    });

    this.pendingRecordsTable.grantReadData(producerFn);
    this.providerQueue.grantSendMessages(producerFn);

    const consumerLogGroup = new logs.LogGroup(this, 'TapiConsumerLogGroup', {
      logGroupName: '/aws/lambda/tapi-consumer',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.consumerFunction = new NodejsFunction(this, 'TapiConsumerFunction', {
      functionName: 'tapi-consumer',
      entry: path.join(__dirname, '../../../src/functions/consumer/handler.sqs.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      logGroup: consumerLogGroup,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        RESULTS_TABLE_NAME: this.resultsTable.tableName,
        TTL_DAYS: String(TTL_DAYS),
        PROVIDER_API_TIMEOUT_MS: '15000',
        LOG_LEVEL: 'INFO',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: [],
        target: 'node20',
      },
    });

    this.resultsTable.grantReadWriteData(this.consumerFunction);
    this.providerQueue.grantConsumeMessages(this.consumerFunction);
    this.consumerFunction.addEventSource(new lambdaEventSources.SqsEventSource(this.providerQueue, {
      batchSize: 1,
      reportBatchItemFailures: true,
    }));

    const schedulerRole = new iam.Role(this, 'TapiSchedulerRole', {
      roleName: 'tapi-scheduler-role',
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Allows EventBridge Scheduler to invoke the Tapi Producer Lambda',
    });

    producerFn.grantInvoke(schedulerRole);

    new scheduler.CfnSchedule(this, 'TapiDailySchedule', {
      name: 'tapi-daily-producer',
      description: 'Triggers the Producer Lambda daily to dispatch pending records to SQS FIFO',
      scheduleExpression: 'cron(0 0 * * ? *)',
      scheduleExpressionTimezone: 'UTC',
      flexibleTimeWindow: {
        mode: 'FLEXIBLE',
        maximumWindowInMinutes: 60,
      },
      target: {
        arn: producerFn.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({
          source: 'tapi.scheduled-daily-run',
          version: '1.0',
        }),
        retryPolicy: {
          maximumEventAgeInSeconds: 3600,
          maximumRetryAttempts: 3,
        },
      },
      state: 'ENABLED',
    });

    new cdk.CfnOutput(this, 'ResultsTableArn', {
      value: this.resultsTable.tableArn,
      description: 'ARN of the DynamoDB Results Table',
      exportName: 'TapiResultsTableArn',
    });

    new cdk.CfnOutput(this, 'PendingRecordsTableArn', {
      value: this.pendingRecordsTable.tableArn,
      description: 'ARN of the DynamoDB Pending Records Table',
      exportName: 'TapiPendingRecordsTableArn',
    });

    new cdk.CfnOutput(this, 'ProviderQueueUrl', {
      value: this.providerQueue.queueUrl,
      description: 'URL of the SQS FIFO Provider Queue',
      exportName: 'TapiProviderQueueUrl',
    });

    new cdk.CfnOutput(this, 'ProviderQueueArn', {
      value: this.providerQueue.queueArn,
      description: 'ARN of the SQS FIFO Provider Queue',
      exportName: 'TapiProviderQueueArn',
    });

    new cdk.CfnOutput(this, 'ProducerFunctionArn', {
      value: producerFn.functionArn,
      description: 'ARN of the Producer Lambda',
      exportName: 'TapiProducerFunctionArn',
    });

    new cdk.CfnOutput(this, 'ConsumerFunctionArn', {
      value: this.consumerFunction.functionArn,
      description: 'ARN of the Consumer Lambda',
      exportName: 'TapiConsumerFunctionArn',
    });
  }
}
