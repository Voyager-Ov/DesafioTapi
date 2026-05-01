import { PendingDispatchRecord, ProviderRecord, SqsMessage } from '../../../../shared/types';
import { DispatchSlotQuery, IQueuePort, IRecordRepositoryPort } from '../../ports/out-ports';

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
   * Main entry point for one distributed date-slot dispatch window.
   *
   * Algorithm:
   *  1. Fetch all records assigned to one date-slot partition from the repository.
   *  2. Transform each ProviderRecord into a SqsMessage with the correct
   *     MessageGroupId (PROVIDER#<id>) for per-provider FIFO ordering.
   *  3. Send messages in batches of SQS_BATCH_SIZE to respect API limits.
   *
   * @param input Distributed dispatch contract with slotId, slotsPerDay and optional targetDate.
   * @returns Dispatch summary for logging/monitoring.
   */
  async execute(input: DispatchWindowInput): Promise<DispatchResult> {
    const targetDate = input.targetDate ?? this.todayUtc();
    const slotQuery: DispatchSlotQuery = {
      targetDate,
      slotId: input.slotId,
      slotsPerDay: input.slotsPerDay,
    };

    const records = await this.recordRepository.getPendingRecordsForSlot(slotQuery);

    if (records.length === 0) {
      return { targetDate, slotId: input.slotId, queried: 0, dispatched: 0, skipped: 0 };
    }

    const queried = records.length;
    const eligibleRecords = records.filter((r) => r.status === 'PENDING');
    const skipped = queried - eligibleRecords.length;

    const messages = eligibleRecords.map((record) =>
      this.buildSqsMessage(record),
    );

    // SQS SendMessageBatch accepts at most 10 entries per call
    const batches = this.chunkArray(messages, BATCH_SIZE);

    for (const batch of batches) {
      await this.queue.sendBatch(batch);
    }

    return {
      targetDate,
      slotId: input.slotId,
      queried,
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
   * MessageDeduplicationId = <recordId>
   *   → Uses the stable logical work-item identity approved for FIFO exactly-once protection.
   */
  private buildSqsMessage(record: PendingDispatchRecord): SqsMessage {
    return {
      messageBody: JSON.stringify(this.toQueuePayload(record)),
      messageGroupId: `PROVIDER#${record.providerId}`,
      messageDeduplicationId: record.recordId,
    };
  }

  private toQueuePayload(record: PendingDispatchRecord): ProviderRecord {
    return {
      recordId: record.recordId,
      providerId: record.providerId,
      endpoint: record.endpoint,
      httpMethod: record.httpMethod,
      payload: record.payload,
      headers: record.headers,
      scheduledDate: record.scheduledDate,
      status: record.status,
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
  readonly targetDate: string;
  readonly slotId: number;
  readonly queried: number;
  readonly dispatched: number;
  readonly skipped: number;
}

export interface DispatchWindowInput {
  readonly slotId: number;
  readonly slotsPerDay: number;
  readonly targetDate?: string;
}
