import { Context } from 'aws-lambda';
import { processProviderRecordUseCase } from './di';
import { ProviderApiResult, ProviderRecord } from '../../shared/types';

export const handler = async (
  event: ProviderRecord,
  context: Context,
): Promise<ProviderApiResult> => {
  console.info(JSON.stringify({
    level: 'INFO',
    message: 'Consumer Lambda invoked',
    recordId: event.recordId,
    providerId: event.providerId,
    requestId: context.awsRequestId,
    remainingTimeMs: context.getRemainingTimeInMillis(),
  }));

  try {
    const result = await processProviderRecordUseCase.execute(event);

    console.info(JSON.stringify({
      level: 'INFO',
      message: 'Consumer processing complete',
      ...result,
      requestId: context.awsRequestId,
    }));

    return result;
  } catch (error) {
    console.error(JSON.stringify({
      level: 'ERROR',
      message: 'Unhandled error in Consumer Lambda',
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : 'UnknownError',
      requestId: context.awsRequestId,
    }));
    throw error;
  }
};
