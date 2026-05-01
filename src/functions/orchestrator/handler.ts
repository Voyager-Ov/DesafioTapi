import { SQSEvent, Context } from 'aws-lambda';
import { StepFunctionsClient, StartExecutionCommand } from '@aws-sdk/client-stepfunctions';
import { ConsumerWorkflowInput, ProviderRecord } from '../../shared/types';

const stateMachineArn = process.env.STATE_MACHINE_ARN ?? requireEnv('STATE_MACHINE_ARN');
export const sfnClient = new StepFunctionsClient({});
const IDEMPOTENCY_TTL_SECONDS = 2 * 24 * 60 * 60;
const RESULTS_TTL_SECONDS = 90 * 24 * 60 * 60;

export const handler = async (event: SQSEvent, context: Context) => {
  const failed: string[] = [];

  console.info(JSON.stringify({
    level: 'INFO',
    message: 'Orchestrator Lambda invoked',
    recordCount: event.Records.length,
    requestId: context.awsRequestId,
  }));

  for (const record of event.Records) {
    const messageId = record.messageId;
    let payload: unknown;

    try {
      payload = JSON.parse(record.body);
    } catch (error) {
      console.error(JSON.stringify({
        level: 'ERROR',
        message: 'Invalid SQS payload for orchestrator',
        messageId,
        body: record.body,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
      failed.push(messageId);
      continue;
    }

    const providerRecord = payload as Record<string, unknown>;
    const recordId = typeof providerRecord.recordId === 'string' ? providerRecord.recordId : undefined;
    const providerId = typeof providerRecord.providerId === 'string' ? providerRecord.providerId : undefined;
    const executionName = `${messageId}-${Date.now()}`;

    try {
      const nowEpochSeconds = Math.floor(Date.now() / 1000);
      const workItem: ProviderRecord = {
        recordId: recordId ?? '',
        providerId: providerId ?? '',
        endpoint: typeof providerRecord.endpoint === 'string' ? providerRecord.endpoint : '',
        httpMethod: isHttpMethod(providerRecord.httpMethod) ? providerRecord.httpMethod : 'GET',
        payload: isObjectRecord(providerRecord.payload) ? providerRecord.payload : {},
        headers: isStringRecord(providerRecord.headers) ? providerRecord.headers : {},
        scheduledDate: typeof providerRecord.scheduledDate === 'string' ? providerRecord.scheduledDate : '',
        status: isRecordStatus(providerRecord.status) ? providerRecord.status : 'PENDING',
      };
      const inputPayload: ConsumerWorkflowInput = {
        workItem,
        workflow: {
          idempotencyTtl: String(nowEpochSeconds + IDEMPOTENCY_TTL_SECONDS),
          resultsTtl: String(nowEpochSeconds + RESULTS_TTL_SECONDS),
        },
      };

      console.info(JSON.stringify({
        level: 'INFO',
        message: 'Starting state machine execution',
        messageId,
        recordId,
        providerId,
        executionName,
        stateMachineArn,
        requestId: context.awsRequestId,
      }));

      const command = new StartExecutionCommand({
        stateMachineArn,
        name: executionName,
        input: JSON.stringify(inputPayload),
      });

      await sfnClient.send(command);

      console.info(JSON.stringify({
        level: 'INFO',
        message: 'State machine execution started',
        messageId,
        recordId,
        providerId,
        executionName,
        stateMachineArn,
        requestId: context.awsRequestId,
      }));
    } catch (error) {
      console.error(JSON.stringify({
        level: 'ERROR',
        message: 'Failed to start state machine execution',
        messageId,
        recordId,
        providerId,
        executionName,
        stateMachineArn,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: error instanceof Error ? error.message : String(error),
        errorMetadata: getErrorMetadata(error),
        requestId: context.awsRequestId,
      }));
      failed.push(messageId);
    }
  }

  if (failed.length > 0) {
    return { batchItemFailures: failed.map((itemIdentifier) => ({ itemIdentifier })) };
  }

  return {};
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getErrorMetadata(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('$metadata' in error)) {
    return undefined;
  }

  return (error as { $metadata?: unknown }).$metadata;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isObjectRecord(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === 'string');
}

function isHttpMethod(value: unknown): value is ProviderRecord['httpMethod'] {
  return value === 'GET' || value === 'POST' || value === 'PUT' || value === 'PATCH';
}

function isRecordStatus(value: unknown): value is ProviderRecord['status'] {
  return value === 'PENDING' || value === 'IN_PROGRESS' || value === 'COMPLETED' || value === 'FAILED';
}
