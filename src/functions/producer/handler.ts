import { ScheduledEvent, Context } from 'aws-lambda';
import { DispatchRecordsUseCase } from './domain/use-cases/dispatch-records.use-case';
import { DynamoDbRecordsAdapter } from './adapters/dynamodb-records.adapter';
import { SqsAdapter } from './adapters/sqs.adapter';

// ---------------------------------------------------------------------------
// Producer Lambda Handler
//
// Primary Adapter (driving adapter) — the AWS runtime entry point.
// Its single responsibility is to:
//   1. Read configuration from environment variables.
//   2. Build the dependency graph (adapters → use case).
//   3. Invoke the domain use case.
//   4. Map the result/error back to a Lambda-compatible response.
//
// Zero business logic lives here. All logic is in the Use Case.
// ---------------------------------------------------------------------------

// Build adapters and wire the dependency graph OUTSIDE the handler
// so they are reused across warm Lambda invocations (connection pooling).
const pendingRecordsTable = requireEnv('PENDING_RECORDS_TABLE');
const sqsQueueUrl = requireEnv('SQS_QUEUE_URL');

const recordRepository = new DynamoDbRecordsAdapter(pendingRecordsTable);
const queue = new SqsAdapter(sqsQueueUrl);
const dispatchRecordsUseCase = new DispatchRecordsUseCase(recordRepository, queue);

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export const handler = async (
  event: ScheduledEvent,
  context: Context,
): Promise<void> => {
  console.info(JSON.stringify({
    level: 'INFO',
    message: 'Producer Lambda invoked',
    source: (event as unknown as Record<string, unknown>).source,
    requestId: context.awsRequestId,
    remainingTimeMs: context.getRemainingTimeInMillis(),
  }));

  try {
    // The date can be overridden in the event payload for manual back-fills.
    // In production, EventBridge sends the standard ScheduledEvent shape,
    // so we default to today UTC.
    const targetDate = extractTargetDate(event);

    const result = await dispatchRecordsUseCase.execute(targetDate);

    console.info(JSON.stringify({
      level: 'INFO',
      message: 'Dispatch complete',
      ...result,
      requestId: context.awsRequestId,
    }));
  } catch (error) {
    // Re-throw so EventBridge Scheduler sees the failure and can retry
    console.error(JSON.stringify({
      level: 'ERROR',
      message: 'Unhandled error in Producer Lambda',
      error: error instanceof Error ? error.message : String(error),
      requestId: context.awsRequestId,
    }));
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the target date from the event payload.
 * Supports a `targetDate` override in the event for manual backfill runs.
 */
function extractTargetDate(event: ScheduledEvent): string | undefined {
  const payload = event as unknown as Record<string, unknown>;
  if (typeof payload.targetDate === 'string') {
    return payload.targetDate;
  }
  return undefined; // Use case defaults to today UTC
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        'Check the CDK stack configuration.',
    );
  }
  return value;
}
