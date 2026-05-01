import { SQSEvent } from 'aws-lambda';

jest.mock('@aws-sdk/client-stepfunctions', () => {
  return {
    StepFunctionsClient: function () {
      return { send: jest.fn() };
    },
    StartExecutionCommand: function (input: any) {
      return input;
    },
  };
});

process.env.STATE_MACHINE_ARN = 'arn:local:stateMachine:test';
const { handler, sfnClient } = require('../../../src/functions/orchestrator/handler');

describe('orchestrator handler', () => {
  beforeEach(() => jest.resetAllMocks());

  it('start executions for each message and returns empty on success', async () => {
    sfnClient.send = jest.fn().mockResolvedValue({});

    const event: SQSEvent = {
      Records: [
        { messageId: 'm1', receiptHandle: 'r1', body: JSON.stringify({ recordId: 'r1', providerId: 'p1', endpoint: 'https://example.com', httpMethod: 'GET', scheduledDate: '2026-04-30', status: 'PENDING' }), attributes: {}, messageAttributes: {}, md5OfBody: '', eventSource: 'aws:sqs', eventSourceARN: '', awsRegion: 'us-east-1' },
        { messageId: 'm2', receiptHandle: 'r2', body: JSON.stringify({ recordId: 'r2', providerId: 'p2', endpoint: 'https://example.com', httpMethod: 'POST', payload: { ok: true }, headers: { a: 'b' }, scheduledDate: '2026-04-30', status: 'PENDING' }), attributes: {}, messageAttributes: {}, md5OfBody: '', eventSource: 'aws:sqs', eventSourceARN: '', awsRegion: 'us-east-1' },
      ],
    } as unknown as SQSEvent;

    const res = await handler(event, {} as any);
    expect(res).toEqual({});
    expect(sfnClient.send).toHaveBeenCalledTimes(2);

    const firstCallInput = sfnClient.send.mock.calls[0][0];
    const parsedInput = JSON.parse(firstCallInput.input);

    expect(parsedInput.workItem.recordId).toBe('r1');
    expect(parsedInput.workItem.providerId).toBe('p1');
    expect(parsedInput.workItem.payload).toEqual({});
    expect(parsedInput.workItem.headers).toEqual({});
    expect(typeof parsedInput.workflow.idempotencyTtl).toBe('string');
    expect(typeof parsedInput.workflow.resultsTtl).toBe('string');
  });

  it('returns batchItemFailures when startExecution fails', async () => {
    sfnClient.send = jest.fn().mockImplementationOnce(() => Promise.resolve({})).mockImplementationOnce(() => Promise.reject(new Error('boom')));

    const event: SQSEvent = {
      Records: [
        { messageId: 'm1', receiptHandle: 'r1', body: JSON.stringify({ recordId: 'r1', providerId: 'p1', endpoint: 'https://example.com', httpMethod: 'GET', scheduledDate: '2026-04-30', status: 'PENDING' }), attributes: {}, messageAttributes: {}, md5OfBody: '', eventSource: 'aws:sqs', eventSourceARN: '', awsRegion: 'us-east-1' },
        { messageId: 'm2', receiptHandle: 'r2', body: JSON.stringify({ recordId: 'r2', providerId: 'p2', endpoint: 'https://example.com', httpMethod: 'GET', scheduledDate: '2026-04-30', status: 'PENDING' }), attributes: {}, messageAttributes: {}, md5OfBody: '', eventSource: 'aws:sqs', eventSourceARN: '', awsRegion: 'us-east-1' },
      ],
    } as unknown as SQSEvent;

    const res = await handler(event, {} as any);
    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm2' }] });
  });

  it('returns batchItemFailures when a message body is invalid JSON', async () => {
    sfnClient.send = jest.fn().mockResolvedValue({});

    const event: SQSEvent = {
      Records: [
        { messageId: 'm1', receiptHandle: 'r1', body: JSON.stringify({ recordId: 'r1', providerId: 'p1', endpoint: 'https://example.com', httpMethod: 'GET', scheduledDate: '2026-04-30', status: 'PENDING' }), attributes: {}, messageAttributes: {}, md5OfBody: '', eventSource: 'aws:sqs', eventSourceARN: '', awsRegion: 'us-east-1' },
        { messageId: 'm2', receiptHandle: 'r2', body: '{invalid-json', attributes: {}, messageAttributes: {}, md5OfBody: '', eventSource: 'aws:sqs', eventSourceARN: '', awsRegion: 'us-east-1' },
      ],
    } as unknown as SQSEvent;

    const res = await handler(event, {} as any);

    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm2' }] });
    expect(sfnClient.send).toHaveBeenCalledTimes(1);
  });
});
