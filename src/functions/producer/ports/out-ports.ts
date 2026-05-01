import { PendingDispatchRecord, SqsMessage } from '../../../shared/types';

// ---------------------------------------------------------------------------
// Producer Output Ports
//
// In Hexagonal Architecture these are "driven ports" — interfaces that the
// domain USE CASE depends on but does NOT implement. The actual implementation
// lives in the Adapters layer (src/functions/producer/adapters/).
//
// This means the domain can be tested with simple in-memory fakes, with no
// real AWS services required.
// ---------------------------------------------------------------------------

export interface DispatchSlotQuery {
  readonly targetDate: string;
  readonly slotId: number;
  readonly slotsPerDay: number;
}

/**
 * Port for reading pending work items.
 * Primary implementation: DynamoDbRecordsAdapter
 */
export interface IRecordRepositoryPort {
  /**
   * Returns all records assigned to the given date-slot partition.
   */
  getPendingRecordsForSlot(query: DispatchSlotQuery): Promise<PendingDispatchRecord[]>;
}

/**
 * Port for publishing messages to a queue.
 * Primary implementation: SqsAdapter
 */
export interface IQueuePort {
  /**
   * Sends a batch of messages to the queue.
   * Implementations must handle batching limits (e.g. SQS max 10 per batch).
   */
  sendBatch(messages: SqsMessage[]): Promise<void>;
}
