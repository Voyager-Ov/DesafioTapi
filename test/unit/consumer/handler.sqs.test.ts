import { SQSEvent } from 'aws-lambda';
import { handler } from '../../../src/functions/consumer/handler.sqs';

// Mock the DI so we can control processProviderRecordUseCase.execute
jest.mock('../../../src/functions/consumer/di', () => ({
  processProviderRecordUseCase: {
    execute: jest.fn(),
  },
}));

const { processProviderRecordUseCase } = require('../../../src/functions/consumer/di');

function makeRecordBody(id = 'rec-1') {
  return {
    recordId: id,
    providerId: 'prov-A',
    endpoint: 'https://api.example.com',
    httpMethod: 'GET',
    scheduledDate: '2025-01-01',
    status: 'PENDING',
  };
}

describe('handler.sqs', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns empty result when all messages succeed', async () => {
    (processProviderRecordUseCase.execute as jest.Mock).mockResolvedValue(undefined);

    const event: SQSEvent = {
      Records: [
        { messageId: 'm1', receiptHandle: 'r1', body: JSON.stringify(makeRecordBody('rec-1')), attributes: {}, messageAttributes: {}, md5OfBody: '', eventSource: 'aws:sqs', eventSourceARN: '', awsRegion: 'us-east-1' },
        { messageId: 'm2', receiptHandle: 'r2', body: JSON.stringify(makeRecordBody('rec-2')), attributes: {}, messageAttributes: {}, md5OfBody: '', eventSource: 'aws:sqs', eventSourceARN: '', awsRegion: 'us-east-1' },
      ],
    } as unknown as SQSEvent;

    const res = await handler(event, {} as any);

    expect(res).toEqual({});
    expect(processProviderRecordUseCase.execute).toHaveBeenCalledTimes(2);
  });

  it('reports failed messageId when process throws', async () => {
    (processProviderRecordUseCase.execute as jest.Mock).mockImplementation(async (payload) => {
      if ((payload as any).recordId === 'rec-fail') throw new Error('boom');
      return undefined;
    });

    const event: SQSEvent = {
      Records: [
        { messageId: 'm1', receiptHandle: 'r1', body: JSON.stringify(makeRecordBody('rec-ok')), attributes: {}, messageAttributes: {}, md5OfBody: '', eventSource: 'aws:sqs', eventSourceARN: '', awsRegion: 'us-east-1' },
        { messageId: 'm2', receiptHandle: 'r2', body: JSON.stringify(makeRecordBody('rec-fail')), attributes: {}, messageAttributes: {}, md5OfBody: '', eventSource: 'aws:sqs', eventSourceARN: '', awsRegion: 'us-east-1' },
      ],
    } as unknown as SQSEvent;

    const res = await handler(event, {} as any);

    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm2' }] });
    expect(processProviderRecordUseCase.execute).toHaveBeenCalledTimes(2);
  });

  it('reports parse error as failure when body is invalid JSON', async () => {
    (processProviderRecordUseCase.execute as jest.Mock).mockResolvedValue(undefined);

    const event: SQSEvent = {
      Records: [
        { messageId: 'm1', receiptHandle: 'r1', body: 'NOT JSON', attributes: {}, messageAttributes: {}, md5OfBody: '', eventSource: 'aws:sqs', eventSourceARN: '', awsRegion: 'us-east-1' },
      ],
    } as unknown as SQSEvent;

    const res = await handler(event, {} as any);

    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    expect(processProviderRecordUseCase.execute).toHaveBeenCalledTimes(0);
  });
});
