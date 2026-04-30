import { ProviderRecord, SqsMessage } from '../../../../shared/types';
import { IQueuePort, IRecordRepositoryPort } from '../../ports/out-ports';

// ---------------------------------------------------------------------------
// DispatchRecordsUseCase
//
// Domain use case: the "brain" of the Producer Lambda.
// Knows NOTHING about AWS, SQS, DynamoDB, HTTP, or Lambda.
// It only speaks in terms of the domain: ProviderRecord and SqsMessage.
//
// Dependencies are injected via constructor (Dependency Inversion Principle).
// This makes it trivially testable with simple in-memory fakes.
// ---------------------------------------------------------------------------
export class DispatchRecordsUseCase {
  constructor(
    private readonly recordRepository: IRecordRepositoryPort,
    private readonly queue: IQueuePort,
  ) {}

  /**
   * Main entry point for the daily batch dispatch.
   *
   * Algorithm:
   *  1. Fetch all PENDING records for today from the repository.
   *  2. Transform each ProviderRecord into a SqsMessage with the correct
   *     MessageGroupId (PROVIDER#<id>) for per-provider FIFO ordering.
   *  3. Send messages in batches of SQS_BATCH_SIZE to respect API limits.
   *
   * @param date ISO date string ('YYYY-MM-DD'). Defaults to today UTC.
   * @returns Dispatch summary for logging/monitoring.
   */
  async execute(date?: string): Promise<DispatchResult> {
    const targetDate = date ?? this.todayUtc();

    const records = await this.recordRepository.getPendingRecords(targetDate);

    if (records.length === 0) {
      return { date: targetDate, dispatched: 0, skipped: 0 };
    }

    // Only PENDING records should be dispatched; filter defensively
    const eligibleRecords = records.filter((r) => r.status === 'PENDING');
    const skipped = records.length - eligibleRecords.length;

    const messages = eligibleRecords.map((record) =>
      this.buildSqsMessage(record),
    );

    // SQS SendMessageBatch accepts at most 10 entries per call
    const batches = this.chunkArray(messages, BATCH_SIZE);

    for (const batch of batches) {
      await this.queue.sendBatch(batch);
    }

    return {
      date: targetDate,
      dispatched: eligibleRecords.length,
      skipped,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers — pure functions, no side-effects
  // ---------------------------------------------------------------------------

  /**
   * Transforms a ProviderRecord into a SqsMessage.
   *
   * MessageGroupId = PROVIDER#<providerId>
   *   → SQS FIFO guarantees that all messages in the same group are
   *     delivered ONE AT A TIME, in order. This is how we enforce
   *     "solo una petición a la vez por proveedor" at the infrastructure level.
   *
   * MessageDeduplicationId = <recordId>#<scheduledDate>
   *   → Prevents duplicate SQS messages if the Producer Lambda retries.
   *     The combination is unique per business day.
   */
  private buildSqsMessage(record: ProviderRecord): SqsMessage {
    return {
      messageBody: JSON.stringify(record),
      messageGroupId: `PROVIDER#${record.providerId}`,
      messageDeduplicationId: `${record.recordId}#${record.scheduledDate}`,
    };
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  private todayUtc(): string {
    return new Date().toISOString().split('T')[0]; // 'YYYY-MM-DD'
  }
}

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

const BATCH_SIZE = 10; // SQS SendMessageBatch hard limit

export interface DispatchResult {
  readonly date: string;
  readonly dispatched: number;
  readonly skipped: number;
}
