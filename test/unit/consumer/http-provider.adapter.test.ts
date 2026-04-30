import { HttpProviderAdapter } from '../../../src/functions/consumer/adapters/http-provider.adapter';
import { TerminalApiError, TransientApiError } from '../../../src/functions/consumer/domain/errors/api.errors';
import { ProviderRecord } from '../../../src/shared/types';

function makeRecord(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    recordId: 'rec-001',
    providerId: 'prov-A',
    endpoint: 'https://api.example.com/resource',
    httpMethod: 'POST',
    payload: { foo: 'bar' },
    headers: { 'x-api-key': 'secret' },
    scheduledDate: '2025-01-15',
    status: 'PENDING',
    ...overrides,
  };
}

describe('HttpProviderAdapter', () => {
  it('envía la petición HTTP y devuelve el resultado parseado', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"ok":true}',
    });
    const adapter = new HttpProviderAdapter(15000, fetchMock as never);

    const result = await adapter.call(makeRecord());

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/resource',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          'x-api-key': 'secret',
        }),
        body: JSON.stringify({ foo: 'bar' }),
      }),
    );
    expect(result.statusCode).toBe(200);
    expect(result.responseBody).toEqual({ ok: true });
  });

  it('clasifica respuestas 503 como TransientApiError', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'service unavailable',
    });
    const adapter = new HttpProviderAdapter(15000, fetchMock as never);

    await expect(adapter.call(makeRecord())).rejects.toBeInstanceOf(TransientApiError);
  });

  it('clasifica respuestas 400 como TerminalApiError', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'bad request',
    });
    const adapter = new HttpProviderAdapter(15000, fetchMock as never);

    await expect(adapter.call(makeRecord())).rejects.toBeInstanceOf(TerminalApiError);
  });

  it('convierte timeout en TransientApiError', async () => {
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    const fetchMock = jest.fn().mockRejectedValue(abortError);
    const adapter = new HttpProviderAdapter(1, fetchMock as never);

    await expect(adapter.call(makeRecord())).rejects.toBeInstanceOf(TransientApiError);
  });
});
