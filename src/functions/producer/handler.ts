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
  const dispatchWindow = extractDispatchWindow(event);

  console.info(JSON.stringify({
    level: 'INFO',
    message: 'Producer Lambda invoked',
    source: (event as unknown as Record<string, unknown>).source,
    slotId: dispatchWindow.slotId,
    slotsPerDay: dispatchWindow.slotsPerDay,
    targetDate: dispatchWindow.targetDate ?? 'today-utc',
    requestId: context.awsRequestId,
    remainingTimeMs: context.getRemainingTimeInMillis(),
  }));

  try {
    const result = await dispatchRecordsUseCase.execute(dispatchWindow);

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
 * Extracts the distributed dispatch contract from the event payload.
 * Supports a `targetDate` override in the event for manual backfill runs.
 * `targetDateStrategy` is scheduler metadata today; the runtime behavior stays:
 * explicit `targetDate` wins, otherwise the producer resolves the current UTC day.
 */
function extractDispatchWindow(event: ScheduledEvent): DispatchWindowInput {
  const payload = event as unknown as Record<string, unknown>;
  const slotId = payload.slotId;
  const slotsPerDay = payload.slotsPerDay;

  if (!Number.isInteger(slotId) || Number(slotId) < 0) {
    throw new Error(`Invalid or missing slotId in dispatch event: ${String(slotId)}`);
  }

  if (!Number.isInteger(slotsPerDay) || Number(slotsPerDay) <= 0) {
    throw new Error(`Invalid or missing slotsPerDay in dispatch event: ${String(slotsPerDay)}`);
  }

  return {
    slotId: Number(slotId),
    slotsPerDay: Number(slotsPerDay),
    targetDate: typeof payload.targetDate === 'string' ? payload.targetDate : undefined,
  };
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

interface DispatchWindowInput {
  readonly slotId: number;
  readonly slotsPerDay: number;
  readonly targetDate?: string;
}
