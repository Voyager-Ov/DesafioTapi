import {
  SQSClient,
  SendMessageBatchCommand,
  SendMessageBatchRequestEntry,
} from '@aws-sdk/client-sqs';
import { IQueuePort } from '../ports/out-ports';
import { SqsMessage } from '../../../shared/types';

// ---------------------------------------------------------------------------
// SqsAdapter
//
// Secondary Adapter (driven adapter) — implements the IQueuePort interface.
// This is the ONLY place where the AWS SQS SDK is used in the Producer.
// The domain use case never imports from '@aws-sdk'.
//
// Accepts an optional SQSClient for dependency injection in tests.
// ---------------------------------------------------------------------------
export class SqsAdapter implements IQueuePort {
  private readonly client: SQSClient;

  constructor(
    private readonly queueUrl: string,
    client?: SQSClient,
  ) {
    // If no client provided, build with default config (uses IAM role in Lambda)
    this.client = client ?? new SQSClient({});
  }

  async sendBatch(messages: SqsMessage[]): Promise<void> {
    if (messages.length === 0) return;
    if (messages.length > 10) {
      throw new Error(
        `SqsAdapter.sendBatch: SQS allows max 10 entries per batch, got ${messages.length}. ` +
          'Use DispatchRecordsUseCase which handles chunking automatically.',
      );
    }

    const entries: SendMessageBatchRequestEntry[] = messages.map((msg, index) => ({
      Id: String(index),
      MessageBody: msg.messageBody,
      MessageGroupId: msg.messageGroupId,
      MessageDeduplicationId: msg.messageDeduplicationId,
    }));

    const command = new SendMessageBatchCommand({
      QueueUrl: this.queueUrl,
      Entries: entries,
    });

    const response = await this.client.send(command);

    if (response.Failed && response.Failed.length > 0) {
      const failedIds = response.Failed.map((f) => f.Id).join(', ');
      const failedMessages = response.Failed
        .map((f) => `[Id=${f.Id}] ${f.Code}: ${f.Message}`)
        .join('; ');
      throw new Error(
        `SqsAdapter.sendBatch: ${response.Failed.length} message(s) failed to send ` +
          `(Ids: ${failedIds}). Details: ${failedMessages}`,
      );
    }
  }
}
