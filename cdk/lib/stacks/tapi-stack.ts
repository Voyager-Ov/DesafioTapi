import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as pipes from 'aws-cdk-lib/aws-pipes';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as path from 'path';

const RESULTS_TTL_DAYS = 90;
const DISPATCH_SLOT_INDEX_NAME = 'dispatch-slot-index';
const DISPATCH_SLOTS_PER_DAY = 288;

export class TapiStack extends cdk.Stack {
  public readonly resultsTable: dynamodb.Table;
  public readonly pendingRecordsTable: dynamodb.Table;
  public readonly idempotencyTable: dynamodb.Table;
  public readonly providerQueue: sqs.Queue;
  public readonly consumerFunction?: lambda.Function;
  public readonly workflowBootstrapFunction?: lambda.Function;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.resultsTable = new dynamodb.Table(this, 'TapiResultsTable', {
      tableName: 'tapi-results',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    this.pendingRecordsTable = new dynamodb.Table(this, 'TapiPendingRecordsTable', {
      tableName: 'tapi-pending-records',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    this.pendingRecordsTable.addGlobalSecondaryIndex({
      indexName: 'provider-date-index',
      partitionKey: { name: 'providerId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.pendingRecordsTable.addGlobalSecondaryIndex({
      indexName: DISPATCH_SLOT_INDEX_NAME,
      partitionKey: { name: 'dispatchSlotPk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'dispatchSortKey', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.idempotencyTable = new dynamodb.Table(this, 'TapiIdempotencyTable', {
      tableName: 'tapi-idempotency',
      partitionKey: { name: 'idempotencyKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    const providerDlq = new sqs.Queue(this, 'TapiProviderDLQ', {
      queueName: 'tapi-provider-dlq.fifo',
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    const schedulerDlq = new sqs.Queue(this, 'TapiSchedulerDLQ', {
      queueName: 'tapi-scheduler-dlq',
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    this.providerQueue = new sqs.Queue(this, 'TapiProviderQueue', {
      queueName: 'tapi-provider-queue.fifo',
      fifo: true,
      contentBasedDeduplication: false,
      deduplicationScope: sqs.DeduplicationScope.MESSAGE_GROUP,
      fifoThroughputLimit: sqs.FifoThroughputLimit.PER_MESSAGE_GROUP_ID,
      visibilityTimeout: cdk.Duration.minutes(6),
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
        PENDING_RECORDS_DISPATCH_SLOT_INDEX: DISPATCH_SLOT_INDEX_NAME,
        TTL_DAYS: String(RESULTS_TTL_DAYS),
        LOG_LEVEL: 'INFO',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: [],
        target: 'node20',
      },
    });

    producerFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:Query', 'dynamodb:DescribeTable'],
      resources: [
        this.pendingRecordsTable.tableArn,
        `${this.pendingRecordsTable.tableArn}/index/${DISPATCH_SLOT_INDEX_NAME}`,
      ],
    }));
    this.providerQueue.grantSendMessages(producerFn);

    const consumerLogGroup = new logs.LogGroup(this, 'TapiConsumerLogGroup', {
      logGroupName: '/aws/lambda/tapi-consumer',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.consumerFunction = new NodejsFunction(this, 'TapiConsumerFunction', {
      functionName: 'tapi-consumer',
      entry: path.join(__dirname, '../../../src/functions/consumer/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      logGroup: consumerLogGroup,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
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

    const workflowBootstrapLogGroup = new logs.LogGroup(this, 'TapiWorkflowBootstrapLogGroup', {
      logGroupName: '/aws/lambda/tapi-workflow-bootstrap',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.workflowBootstrapFunction = new NodejsFunction(this, 'TapiWorkflowBootstrapFunction', {
      functionName: 'tapi-workflow-bootstrap',
      entry: path.join(__dirname, '../../../src/functions/workflow-bootstrap/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      logGroup: workflowBootstrapLogGroup,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        LOG_LEVEL: 'INFO',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: [],
        target: 'node20',
      },
    });

    const bootstrapWorkflowInput = new tasks.LambdaInvoke(this, 'BootstrapWorkflowInput', {
      lambdaFunction: this.workflowBootstrapFunction,
      payload: stepfunctions.TaskInput.fromObject({
        workItem: stepfunctions.JsonPath.objectAt('$[0].workItem'),
        workflow: stepfunctions.JsonPath.objectAt('$[0].workflow'),
      }),
      payloadResponseOnly: true,
      resultPath: '$',
    });

    const invokeConsumer = new tasks.LambdaInvoke(this, 'InvokeConsumerLambda', {
      lambdaFunction: this.consumerFunction,
      payload: stepfunctions.TaskInput.fromObject({
        recordId: stepfunctions.JsonPath.stringAt('$.workItem.recordId'),
        providerId: stepfunctions.JsonPath.stringAt('$.workItem.providerId'),
        endpoint: stepfunctions.JsonPath.stringAt('$.workItem.endpoint'),
        httpMethod: stepfunctions.JsonPath.stringAt('$.workItem.httpMethod'),
        payload: stepfunctions.JsonPath.objectAt('$.workItem.payload'),
        headers: stepfunctions.JsonPath.objectAt('$.workItem.headers'),
        scheduledDate: stepfunctions.JsonPath.stringAt('$.workItem.scheduledDate'),
        status: stepfunctions.JsonPath.stringAt('$.workItem.status'),
      }),
      payloadResponseOnly: true,
      resultPath: '$.consumerResult',
    });

    invokeConsumer.addRetry({
      errors: ['TransientApiError', 'States.Timeout', 'States.TaskFailed'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 3,
      backoffRate: 2,
      jitterStrategy: stepfunctions.JitterType.FULL,
    });

    const duplicateWorkItem = new stepfunctions.Pass(this, 'DuplicateWorkItem');

    const completeWorkflow = new stepfunctions.Succeed(this, 'WorkflowCompleted');

    const idempotencyKeyPath = stepfunctions.JsonPath.format(
      '{}#{}',
      stepfunctions.JsonPath.stringAt('$.workItem.recordId'),
      stepfunctions.JsonPath.stringAt('$.workItem.scheduledDate'),
    );
    const pendingPkPath = stepfunctions.JsonPath.format(
      'DATE#{}',
      stepfunctions.JsonPath.stringAt('$.workItem.scheduledDate'),
    );
    const pendingSkPath = stepfunctions.JsonPath.format(
      'RECORD#{}',
      stepfunctions.JsonPath.stringAt('$.workItem.recordId'),
    );
    const acquireIdempotencyLock = new tasks.DynamoPutItem(this, 'AcquireIdempotencyLock', {
      table: this.idempotencyTable,
      item: {
        idempotencyKey: tasks.DynamoAttributeValue.fromString(idempotencyKeyPath),
        recordId: tasks.DynamoAttributeValue.fromString(stepfunctions.JsonPath.stringAt('$.workItem.recordId')),
        providerId: tasks.DynamoAttributeValue.fromString(stepfunctions.JsonPath.stringAt('$.workItem.providerId')),
        scheduledDate: tasks.DynamoAttributeValue.fromString(stepfunctions.JsonPath.stringAt('$.workItem.scheduledDate')),
        status: tasks.DynamoAttributeValue.fromString('IN_PROGRESS'),
        startedAt: tasks.DynamoAttributeValue.fromString(stepfunctions.JsonPath.stringAt('$$.State.EnteredTime')),
        ttl: tasks.DynamoAttributeValue.numberFromString(stepfunctions.JsonPath.stringAt('$.workflow.idempotencyTtl')),
      },
      conditionExpression: 'attribute_not_exists(idempotencyKey)',
      resultPath: stepfunctions.JsonPath.DISCARD,
    });

    acquireIdempotencyLock.addCatch(duplicateWorkItem, {
      errors: ['DynamoDB.ConditionalCheckFailedException', 'ConditionalCheckFailedException'],
      resultPath: stepfunctions.JsonPath.DISCARD,
    });

    const markPendingInProgress = new tasks.DynamoUpdateItem(this, 'MarkPendingInProgress', {
      table: this.pendingRecordsTable,
      key: {
        PK: tasks.DynamoAttributeValue.fromString(pendingPkPath),
        SK: tasks.DynamoAttributeValue.fromString(pendingSkPath),
      },
      updateExpression: 'SET #status = :status',
      conditionExpression: '#status = :expected',
      expressionAttributeNames: {
        '#status': 'status',
      },
      expressionAttributeValues: {
        ':status': tasks.DynamoAttributeValue.fromString('IN_PROGRESS'),
        ':expected': tasks.DynamoAttributeValue.fromString('PENDING'),
      },
      resultPath: stepfunctions.JsonPath.DISCARD,
    });

    const rollbackIdempotencyLock = new tasks.DynamoDeleteItem(this, 'RollbackIdempotencyLock', {
      table: this.idempotencyTable,
      key: {
        idempotencyKey: tasks.DynamoAttributeValue.fromString(idempotencyKeyPath),
      },
      resultPath: stepfunctions.JsonPath.DISCARD,
    });

    markPendingInProgress.addCatch(rollbackIdempotencyLock, {
      errors: ['DynamoDB.ConditionalCheckFailedException', 'ConditionalCheckFailedException'],
      resultPath: stepfunctions.JsonPath.DISCARD,
    });

    const markIdempotencyCompleted = new tasks.DynamoUpdateItem(this, 'MarkIdempotencyCompleted', {
      table: this.idempotencyTable,
      key: {
        idempotencyKey: tasks.DynamoAttributeValue.fromString(idempotencyKeyPath),
      },
      updateExpression: 'SET #status = :status, completedAt = :completedAt',
      expressionAttributeNames: {
        '#status': 'status',
      },
      expressionAttributeValues: {
        ':status': tasks.DynamoAttributeValue.fromString('COMPLETED'),
        ':completedAt': tasks.DynamoAttributeValue.fromString(stepfunctions.JsonPath.stringAt('$$.State.EnteredTime')),
      },
      resultPath: stepfunctions.JsonPath.DISCARD,
    });

    const markPendingCompleted = new tasks.DynamoUpdateItem(this, 'MarkPendingCompleted', {
      table: this.pendingRecordsTable,
      key: {
        PK: tasks.DynamoAttributeValue.fromString(pendingPkPath),
        SK: tasks.DynamoAttributeValue.fromString(pendingSkPath),
      },
      updateExpression: 'SET #status = :status',
      expressionAttributeNames: {
        '#status': 'status',
      },
      expressionAttributeValues: {
        ':status': tasks.DynamoAttributeValue.fromString('COMPLETED'),
      },
      resultPath: stepfunctions.JsonPath.DISCARD,
    });

    const parseWorkflowErrorEnvelope = new stepfunctions.Pass(this, 'ParseWorkflowErrorEnvelope', {
      parameters: {
        'workItem.$': '$.workItem',
        'workflow.$': '$.workflow',
        'workflowError.$': '$.workflowError',
        'parsedWorkflowError.$': 'States.StringToJson($.workflowError.Cause)',
      },
      resultPath: '$',
    });

    const parseWorkflowErrorPayload = new stepfunctions.Pass(this, 'ParseWorkflowErrorPayload', {
      parameters: {
        'workItem.$': '$.workItem',
        'workflow.$': '$.workflow',
        'workflowError.$': '$.workflowError',
        'parsedWorkflowError.$': '$.parsedWorkflowError',
        'parsedErrorPayload.$': 'States.StringToJson($.parsedWorkflowError.errorMessage)',
      },
      resultPath: '$',
    });

    const normalizeTerminalFailure = new stepfunctions.Pass(this, 'NormalizeTerminalFailure', {
      parameters: {
        'workItem.$': '$.workItem',
        'workflow.$': '$.workflow',
        'workflowError.$': '$.workflowError',
        normalizedFailure: {
          'statusCode.$': '$.parsedErrorPayload.statusCode',
          'message.$': '$.parsedErrorPayload.message',
          category: 'TERMINAL',
          errorType: 'TerminalApiError',
        },
      },
      resultPath: '$',
    });

    const normalizeTransientExhaustedFailure = new stepfunctions.Pass(this, 'NormalizeTransientExhaustedFailure', {
      parameters: {
        'workItem.$': '$.workItem',
        'workflow.$': '$.workflow',
        'workflowError.$': '$.workflowError',
        normalizedFailure: {
          'statusCode.$': '$.parsedErrorPayload.statusCode',
          'message.$': '$.parsedErrorPayload.message',
          category: 'TRANSIENT_EXHAUSTED',
          errorType: 'TransientApiError',
        },
      },
      resultPath: '$',
    });

    const normalizeTimeoutFailure = new stepfunctions.Pass(this, 'NormalizeTimeoutFailure', {
      parameters: {
        'workItem.$': '$.workItem',
        'workflow.$': '$.workflow',
        'workflowError.$': '$.workflowError',
        normalizedFailure: {
          statusCode: 504,
          message: 'Provider execution timed out',
          category: 'TIMEOUT',
          errorType: 'States.Timeout',
        },
      },
      resultPath: '$',
    });

    const normalizeUnexpectedFailure = new stepfunctions.Pass(this, 'NormalizeUnexpectedFailure', {
      parameters: {
        'workItem.$': '$.workItem',
        'workflow.$': '$.workflow',
        'workflowError.$': '$.workflowError',
        normalizedFailure: {
          statusCode: 500,
          'message.$': '$.workflowError.Cause',
          category: 'UNEXPECTED',
          'errorType.$': '$.workflowError.Error',
        },
      },
      resultPath: '$',
    });

    const normalizeUnexpectedClosureFailure = new stepfunctions.Pass(this, 'NormalizeUnexpectedClosureFailure', {
      parameters: {
        'workItem.$': '$.workItem',
        'workflow.$': '$.workflow',
        'workflowError.$': '$.closureError',
        normalizedFailure: {
          statusCode: 500,
          'message.$': '$.closureError.Cause',
          category: 'UNEXPECTED',
          'errorType.$': '$.closureError.Error',
        },
      },
      resultPath: '$',
    });

    const routeClassifiedFailure = new stepfunctions.Choice(this, 'RouteClassifiedFailure')
      .when(
        stepfunctions.Condition.stringEquals('$.workflowError.Error', 'TerminalApiError'),
        normalizeTerminalFailure,
      )
      .otherwise(normalizeTransientExhaustedFailure);

    const prepareSuccessPersistence = new stepfunctions.Pass(this, 'PrepareSuccessPersistence', {
      parameters: {
        'workItem.$': '$.workItem',
        'workflow.$': '$.workflow',
        'consumerResult.$': '$.consumerResult',
        persistence: {
          'resultPk.$': "States.Format('PROVIDER#{}', $.workItem.providerId)",
          'resultSk.$': "States.Format('TIMESTAMP#{}#{}', $.consumerResult.processedAt, $.workItem.recordId)",
          'statusCodeText.$': "States.Format('{}', $.consumerResult.statusCode)",
          'durationMsText.$': "States.Format('{}', $.consumerResult.durationMs)",
          'responseBodyText.$': '$.consumerResult.responseBody',
          'processedAt.$': '$.consumerResult.processedAt',
          'ttlText.$': '$.workflow.resultsTtl',
        },
      },
      resultPath: '$',
    });

    const prepareFailurePersistence = new stepfunctions.Pass(this, 'PrepareFailurePersistence', {
      parameters: {
        'workItem.$': '$.workItem',
        'workflow.$': '$.workflow',
        'workflowError.$': '$.workflowError',
        'normalizedFailure.$': '$.normalizedFailure',
        persistence: {
          'resultPk.$': "States.Format('PROVIDER#{}', $.workItem.providerId)",
          'resultSk.$': "States.Format('TIMESTAMP#{}#{}', $$.State.EnteredTime, $.workItem.recordId)",
          'statusCodeText.$': "States.Format('{}', $.normalizedFailure.statusCode)",
          durationMsText: '0',
          'responseBodyText.$': 'States.JsonToString($.normalizedFailure)',
          'processedAt.$': '$$.State.EnteredTime',
          'ttlText.$': '$.workflow.resultsTtl',
        },
      },
      resultPath: '$',
    });

    const persistSuccessResult = new tasks.DynamoPutItem(this, 'PersistSuccessResult', {
      table: this.resultsTable,
      item: {
        PK: tasks.DynamoAttributeValue.fromString(stepfunctions.JsonPath.stringAt('$.persistence.resultPk')),
        SK: tasks.DynamoAttributeValue.fromString(stepfunctions.JsonPath.stringAt('$.persistence.resultSk')),
        recordId: tasks.DynamoAttributeValue.fromString(stepfunctions.JsonPath.stringAt('$.workItem.recordId')),
        providerId: tasks.DynamoAttributeValue.fromString(stepfunctions.JsonPath.stringAt('$.workItem.providerId')),
        statusCode: tasks.DynamoAttributeValue.numberFromString(
          stepfunctions.JsonPath.stringAt('$.persistence.statusCodeText'),
        ),
        responseBody: tasks.DynamoAttributeValue.fromString(
          stepfunctions.JsonPath.stringAt('$.persistence.responseBodyText'),
        ),
        durationMs: tasks.DynamoAttributeValue.numberFromString(
          stepfunctions.JsonPath.stringAt('$.persistence.durationMsText'),
        ),
        processedAt: tasks.DynamoAttributeValue.fromString(
          stepfunctions.JsonPath.stringAt('$.persistence.processedAt'),
        ),
        ttl: tasks.DynamoAttributeValue.numberFromString(stepfunctions.JsonPath.stringAt('$.persistence.ttlText')),
      },
      resultPath: stepfunctions.JsonPath.DISCARD,
    });

    const persistFailureResult = new tasks.DynamoPutItem(this, 'PersistFailureResult', {
      table: this.resultsTable,
      item: {
        PK: tasks.DynamoAttributeValue.fromString(stepfunctions.JsonPath.stringAt('$.persistence.resultPk')),
        SK: tasks.DynamoAttributeValue.fromString(stepfunctions.JsonPath.stringAt('$.persistence.resultSk')),
        recordId: tasks.DynamoAttributeValue.fromString(stepfunctions.JsonPath.stringAt('$.workItem.recordId')),
        providerId: tasks.DynamoAttributeValue.fromString(stepfunctions.JsonPath.stringAt('$.workItem.providerId')),
        statusCode: tasks.DynamoAttributeValue.numberFromString(
          stepfunctions.JsonPath.stringAt('$.persistence.statusCodeText'),
        ),
        responseBody: tasks.DynamoAttributeValue.fromString(
          stepfunctions.JsonPath.stringAt('$.persistence.responseBodyText'),
        ),
        durationMs: tasks.DynamoAttributeValue.numberFromString(
          stepfunctions.JsonPath.stringAt('$.persistence.durationMsText'),
        ),
        processedAt: tasks.DynamoAttributeValue.fromString(
          stepfunctions.JsonPath.stringAt('$.persistence.processedAt'),
        ),
        ttl: tasks.DynamoAttributeValue.numberFromString(stepfunctions.JsonPath.stringAt('$.persistence.ttlText')),
      },
      resultPath: stepfunctions.JsonPath.DISCARD,
    });

    const markIdempotencyFailed = new tasks.DynamoUpdateItem(this, 'MarkIdempotencyFailed', {
      table: this.idempotencyTable,
      key: {
        idempotencyKey: tasks.DynamoAttributeValue.fromString(idempotencyKeyPath),
      },
      updateExpression: 'SET #status = :status, failedAt = :failedAt, failureReason = :reason',
      expressionAttributeNames: {
        '#status': 'status',
      },
      expressionAttributeValues: {
        ':status': tasks.DynamoAttributeValue.fromString('FAILED'),
        ':failedAt': tasks.DynamoAttributeValue.fromString(stepfunctions.JsonPath.stringAt('$$.State.EnteredTime')),
        ':reason': tasks.DynamoAttributeValue.fromString(
          stepfunctions.JsonPath.stringAt('$.normalizedFailure.category'),
        ),
      },
      resultPath: stepfunctions.JsonPath.DISCARD,
    });

    const markPendingFailed = new tasks.DynamoUpdateItem(this, 'MarkPendingFailed', {
      table: this.pendingRecordsTable,
      key: {
        PK: tasks.DynamoAttributeValue.fromString(pendingPkPath),
        SK: tasks.DynamoAttributeValue.fromString(pendingSkPath),
      },
      updateExpression: 'SET #status = :status',
      expressionAttributeNames: {
        '#status': 'status',
      },
      expressionAttributeValues: {
        ':status': tasks.DynamoAttributeValue.fromString('FAILED'),
      },
      resultPath: stepfunctions.JsonPath.DISCARD,
    });
    const duplicateWorkItemPath = duplicateWorkItem.next(completeWorkflow);
    rollbackIdempotencyLock.next(duplicateWorkItemPath);
    const successPath = prepareSuccessPersistence
      .next(persistSuccessResult)
      .next(markIdempotencyCompleted)
      .next(markPendingCompleted)
      .next(completeWorkflow);
    const failureClosurePath = prepareFailurePersistence
      .next(persistFailureResult)
      .next(markIdempotencyFailed)
      .next(markPendingFailed)
      .next(completeWorkflow);

    const terminalFailurePath = normalizeTerminalFailure.next(failureClosurePath);
    const transientExhaustedFailurePath = normalizeTransientExhaustedFailure.next(failureClosurePath);
    const timeoutFailurePath = normalizeTimeoutFailure.next(failureClosurePath);
    const unexpectedFailurePath = normalizeUnexpectedFailure.next(failureClosurePath);
    const unexpectedClosureFailurePath = normalizeUnexpectedClosureFailure.next(failureClosurePath);

    parseWorkflowErrorEnvelope
      .next(parseWorkflowErrorPayload)
      .next(routeClassifiedFailure);

    invokeConsumer
      .addCatch(parseWorkflowErrorEnvelope, {
        errors: ['TerminalApiError', 'TransientApiError'],
        resultPath: '$.workflowError',
      })
      .addCatch(timeoutFailurePath, {
        errors: ['States.Timeout'],
        resultPath: '$.workflowError',
      })
      .addCatch(unexpectedFailurePath, {
        errors: ['States.ALL'],
        resultPath: '$.workflowError',
      });

    persistSuccessResult.addCatch(unexpectedClosureFailurePath, {
      errors: ['States.ALL'],
      resultPath: '$.closureError',
    });
    markIdempotencyCompleted.addCatch(unexpectedClosureFailurePath, {
      errors: ['States.ALL'],
      resultPath: '$.closureError',
    });
    markPendingCompleted.addCatch(unexpectedClosureFailurePath, {
      errors: ['States.ALL'],
      resultPath: '$.closureError',
    });
    persistFailureResult.addCatch(markIdempotencyFailed, {
      errors: ['States.ALL'],
      resultPath: stepfunctions.JsonPath.DISCARD,
    });

    const workflowDefinition = stepfunctions.Chain
      .start(bootstrapWorkflowInput)
      .next(acquireIdempotencyLock)
      .next(markPendingInProgress)
      .next(invokeConsumer)
      .next(successPath);

    const stateMachine = new stepfunctions.StateMachine(this, 'TapiConsumerStateMachine', {
      definitionBody: stepfunctions.DefinitionBody.fromChainable(workflowDefinition),
      stateMachineName: 'tapi-consumer-state-machine-express',
      stateMachineType: stepfunctions.StateMachineType.EXPRESS,
      timeout: cdk.Duration.minutes(4),
      logs: {
        destination: new logs.LogGroup(this, 'TapiConsumerStateMachineLogs', {
          logGroupName: '/aws/vendedlogs/states/tapi-consumer-state-machine',
          retention: logs.RetentionDays.TWO_WEEKS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        level: stepfunctions.LogLevel.ALL,
      },
      tracingEnabled: false,
    });

    const pipeRole = new iam.Role(this, 'TapiProviderPipeRole', {
      roleName: 'tapi-provider-pipe-role',
      assumedBy: new iam.ServicePrincipal('pipes.amazonaws.com'),
      description: 'Allows EventBridge Pipes to consume the provider FIFO queue and invoke the Step Functions workflow',
    });
    this.providerQueue.grantConsumeMessages(pipeRole);
    stateMachine.grantStartSyncExecution(pipeRole);

    new pipes.CfnPipe(this, 'TapiProviderPipe', {
      roleArn: pipeRole.roleArn,
      source: this.providerQueue.queueArn,
      target: stateMachine.stateMachineArn,
      sourceParameters: {
        sqsQueueParameters: {
          batchSize: 1,
        },
      },
      targetParameters: {
        inputTemplate: [
          '{',
          '"workItem": <$.body>,',
          '"workflow": {',
          '"sourceMessageId": <$.messageId>,',
          '"sourceIngestedAt": <aws.pipes.event.ingestion-time>',
          '}',
          '}',
        ].join(''),
        stepFunctionStateMachineParameters: {
          invocationType: 'REQUEST_RESPONSE',
        },
      },
      desiredState: 'RUNNING',
      name: 'tapi-provider-pipe',
    });

    const schedulerRole = new iam.Role(this, 'TapiSchedulerRole', {
      roleName: 'tapi-scheduler-role',
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Allows EventBridge Scheduler to invoke the Tapi Producer Lambda and write to the Scheduler DLQ',
    });

    producerFn.grantInvoke(schedulerRole);
    schedulerDlq.grantSendMessages(schedulerRole);

    for (let slotId = 0; slotId < DISPATCH_SLOTS_PER_DAY; slotId += 1) {
      const hour = Math.floor(slotId / 12);
      const minute = (slotId % 12) * 5;

      new scheduler.CfnSchedule(this, `TapiDispatchSlotSchedule${slotId}`, {
        name: `tapi-dispatch-slot-${String(slotId).padStart(3, '0')}`,
        description: `Triggers the Producer Lambda for dispatch slot ${slotId}`,
        scheduleExpression: `cron(${minute} ${hour} * * ? *)`,
        scheduleExpressionTimezone: 'UTC',
        flexibleTimeWindow: {
          mode: 'OFF',
        },
        target: {
          arn: producerFn.functionArn,
          roleArn: schedulerRole.roleArn,
          input: JSON.stringify({
            source: 'tapi.distributed-dispatch',
            slotId,
            slotsPerDay: DISPATCH_SLOTS_PER_DAY,
            targetDateStrategy: 'today-utc-by-default',
          }),
          retryPolicy: {
            maximumEventAgeInSeconds: 3600,
            maximumRetryAttempts: 3,
          },
          deadLetterConfig: {
            arn: schedulerDlq.queueArn,
          },
        },
        state: 'ENABLED',
      });
    }

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

    new cdk.CfnOutput(this, 'IdempotencyTableArn', {
      value: this.idempotencyTable.tableArn,
      description: 'ARN of the DynamoDB Idempotency Table',
      exportName: 'TapiIdempotencyTableArn',
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
