import { ProviderRecord, SqsMessage } from '../../../shared/types';

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

/**
 * Port for reading pending work items.
 * Primary implementation: DynamoDbRecordsAdapter
 */
export interface IRecordRepositoryPort {
  /**
   * Returns all PENDING records scheduled for the given date.
   * @param date ISO date string: 'YYYY-MM-DD'
   */
  getPendingRecords(date: string): Promise<ProviderRecord[]>;
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
