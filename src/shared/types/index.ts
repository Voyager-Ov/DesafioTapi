// ---------------------------------------------------------------------------
// Shared Domain Types
//
// These are pure TypeScript interfaces. They have ZERO dependency on AWS SDKs,
// HTTP clients, or any infrastructure concern. This is the core of the
// Hexagonal Architecture — the domain stays isolated.
// ---------------------------------------------------------------------------

/** A single unit of work read from the Pending Records table */
export interface ProviderRecord {
  readonly recordId: string;
  readonly providerId: string;
  readonly endpoint: string;
  readonly httpMethod: 'GET' | 'POST' | 'PUT' | 'PATCH';
  readonly payload?: Record<string, unknown>;
  readonly headers?: Record<string, string>;
  readonly scheduledDate: string;   // ISO date: 'YYYY-MM-DD'
  readonly status: RecordStatus;
}

export interface DispatchSlotMetadata {
  readonly dispatchDate: string;
  readonly dispatchSlot: number;
  readonly dispatchSlotPk: string;
  readonly dispatchSortKey: string;
}

export interface PendingDispatchRecord extends ProviderRecord, DispatchSlotMetadata {}

export interface PendingRecordWriteInput extends ProviderRecord {
  readonly ttl?: number;
}

export interface PendingRecordItem extends PendingDispatchRecord {
  readonly PK: string;
  readonly SK: string;
  readonly ttl?: number;
}

export type RecordStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

/** Message sent to SQS FIFO. One message = one ProviderRecord. */
export interface SqsMessage {
  readonly messageBody: string;
  /** Maps to SQS MessageGroupId: PROVIDER#<providerId> */
  readonly messageGroupId: string;
  /** Maps to SQS MessageDeduplicationId: prevents duplicate sends */
  readonly messageDeduplicationId: string;
}

/** The result of calling an external provider API */
export interface ProviderApiResult {
  readonly recordId: string;
  readonly providerId: string;
  readonly statusCode: number;
  readonly responseBody: string;
  readonly durationMs: number;
  readonly processedAt: string;   // ISO 8601 timestamp
}

export interface WorkflowMetadata {
  readonly idempotencyTtl: string;
  readonly resultsTtl: string;
  readonly sourceMessageId?: string;
  readonly sourceIngestedAt?: string;
}

export interface ConsumerWorkflowInput {
  readonly workItem: ProviderRecord;
  readonly workflow: WorkflowMetadata;
}

/** What gets written to the DynamoDB Results table */
export interface ResultRecord {
  /** PK: PROVIDER#<providerId> */
  readonly PK: string;
  /** SK: TIMESTAMP#<ISO timestamp>#<recordId> — write sharding */
  readonly SK: string;
  readonly recordId: string;
  readonly providerId: string;
  readonly statusCode: number;
  readonly responseBody: string;
  readonly durationMs: number;
  readonly processedAt: string;
  /** Unix epoch seconds — DynamoDB TTL field */
  readonly ttl: number;
}

export interface IdempotencyRecord {
  readonly idempotencyKey: string;
  readonly recordId: string;
  readonly providerId: string;
  readonly scheduledDate: string;
  readonly status: IdempotencyStatus;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly failedAt?: string;
  readonly failureReason?: string;
  readonly ttl: number;
}

export type IdempotencyStatus = 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

/** Error types the consumer domain can distinguish */
export type ApiErrorKind =
  | 'TRANSIENT'   // 429, 503 — safe to retry with backoff
  | 'TERMINAL';   // 400, 401, 403, 404 — do not retry

export interface ApiError {
  readonly kind: ApiErrorKind;
  readonly statusCode: number;
  readonly message: string;
}
