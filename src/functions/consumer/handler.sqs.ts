import { SQSEvent, Context } from 'aws-lambda';
import { ProviderRecord } from '../../shared/types';
import { processProviderRecordUseCase } from './di';

/**
 * SQS handler that supports partial failures using batch item failures.
 * Returns { batchItemFailures: [{ itemIdentifier }] } when some messages fail.
 */
export const handler = async (event: SQSEvent, context: Context) => {
  const failed: string[] = [];

  for (const record of event.Records) {
    const id = record.messageId;
    let payload: ProviderRecord | undefined;
    try {
      payload = JSON.parse(record.body) as ProviderRecord;
    } catch (e) {
      // Cannot parse — mark as failed so SQS will handle per its retry/DLQ
      failed.push(id);
      continue;
    }

    try {
      await processProviderRecordUseCase.execute(payload);
    } catch (e) {
      // Let the domain error types drive retry vs terminal behavior.
      // For batch item failure reporting we add the item id so Lambda can report.
      failed.push(id);
    }
  }

  if (failed.length > 0) {
    return {
      batchItemFailures: failed.map((itemIdentifier) => ({ itemIdentifier })),
    };
  }

  return {};
};
