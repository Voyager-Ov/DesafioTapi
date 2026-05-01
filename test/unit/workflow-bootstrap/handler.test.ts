import { handler } from '../../../src/functions/workflow-bootstrap/handler';

describe('workflow bootstrap handler', () => {
  it('adds TTL metadata while preserving the work item contract', async () => {
    const result = await handler({
      workItem: {
        recordId: 'rec-501',
        providerId: 'prov-Q',
        endpoint: 'https://example.com',
        httpMethod: 'GET',
        scheduledDate: '2026-05-01',
        status: 'PENDING',
      },
      workflow: {
        sourceMessageId: 'msg-1',
        sourceIngestedAt: '2026-05-01T10:00:00.000Z',
      },
    }, {
      awsRequestId: 'req-1',
    } as never);

    expect(result.workItem.recordId).toBe('rec-501');
    expect(result.workItem.payload).toEqual({});
    expect(result.workItem.headers).toEqual({});
    expect(result.workflow.sourceMessageId).toBe('msg-1');
    expect(result.workflow.idempotencyTtl).toEqual(expect.any(String));
    expect(result.workflow.resultsTtl).toEqual(expect.any(String));
  });

  it('preserves explicit payload and headers when they exist', async () => {
    const result = await handler({
      workItem: {
        recordId: 'rec-502',
        providerId: 'prov-R',
        endpoint: 'https://example.com',
        httpMethod: 'POST',
        payload: { foo: 'bar' },
        headers: { Authorization: 'Bearer token' },
        scheduledDate: '2026-05-01',
        status: 'PENDING',
      },
    }, {
      awsRequestId: 'req-2',
    } as never);

    expect(result.workItem.payload).toEqual({ foo: 'bar' });
    expect(result.workItem.headers).toEqual({ Authorization: 'Bearer token' });
  });
});
