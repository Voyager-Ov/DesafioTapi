import { ProcessProviderRecordUseCase } from '../../../src/functions/consumer/domain/use-cases/process-record.use-case';
import { IProviderApiPort } from '../../../src/functions/consumer/ports/out-ports';
import {
  TerminalApiError,
  TransientApiError,
  classifyHttpError,
} from '../../../src/functions/consumer/domain/errors/api.errors';
import { ProviderApiResult, ProviderRecord } from '../../../src/shared/types';

class FakeProviderApi implements IProviderApiPort {
  constructor(
    private readonly response: ProviderApiResult | Error,
  ) {}

  async call(_record: ProviderRecord): Promise<ProviderApiResult> {
    if (this.response instanceof Error) throw this.response;
    return this.response;
  }
}

function makeRecord(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    recordId: 'rec-001',
    providerId: 'prov-A',
    endpoint: 'https://api.proveedor.com/consulta',
    httpMethod: 'GET',
    scheduledDate: '2025-01-15',
    status: 'PENDING',
    ...overrides,
  };
}

function makeApiResult(overrides: Partial<ProviderApiResult> = {}): ProviderApiResult {
  return {
    recordId: 'rec-001',
    providerId: 'prov-A',
    statusCode: 200,
    responseBody: '{"data":"ok"}',
    durationMs: 123,
    processedAt: '2025-01-15T10:00:00.000Z',
    ...overrides,
  };
}

describe('ProcessProviderRecordUseCase', () => {
  describe('HAPPY PATH - API responde exitosamente', () => {
    it('retorna el resultado completo del proveedor', async () => {
      const apiResult = makeApiResult();
      const useCase = new ProcessProviderRecordUseCase(
        new FakeProviderApi(apiResult),
      );

      await expect(useCase.execute(makeRecord())).resolves.toEqual(apiResult);
    });

    it('preserva responseBody, durationMs y processedAt para Step Functions', async () => {
      const apiResult = makeApiResult({
        durationMs: 456,
        statusCode: 200,
        responseBody: '{"ok":true}',
        processedAt: '2025-01-15T12:34:56.000Z',
      });
      const useCase = new ProcessProviderRecordUseCase(
        new FakeProviderApi(apiResult),
      );

      const result = await useCase.execute(makeRecord());

      expect(result.responseBody).toBe('{"ok":true}');
      expect(result.durationMs).toBe(456);
      expect(result.statusCode).toBe(200);
      expect(result.processedAt).toBe('2025-01-15T12:34:56.000Z');
    });
  });

  describe('ERROR TRANSITORIO - 429, 503 (reintentar)', () => {
    it.each([429, 502, 503, 504])(
      'lanza TransientApiError para HTTP %i',
      async (statusCode) => {
        const useCase = new ProcessProviderRecordUseCase(
          new FakeProviderApi(new TransientApiError(statusCode, `HTTP ${statusCode}`)),
        );

        await expect(useCase.execute(makeRecord())).rejects.toBeInstanceOf(TransientApiError);
      },
    );

    it('el error tiene el nombre correcto para que Step Functions lo detecte', async () => {
      const useCase = new ProcessProviderRecordUseCase(
        new FakeProviderApi(new TransientApiError(429, 'rate limited')),
      );

      const error = await useCase.execute(makeRecord()).catch((e) => e);
      expect((error as Error).name).toBe('TransientApiError');
      expect(JSON.parse((error as Error).message)).toMatchObject({
        statusCode: 429,
        category: 'TRANSIENT',
      });
    });
  });

  describe('ERROR TERMINAL - 400, 401, 403 (abortar y alertar)', () => {
    it.each([400, 401, 403, 404])(
      'lanza TerminalApiError para HTTP %i',
      async (statusCode) => {
        const useCase = new ProcessProviderRecordUseCase(
          new FakeProviderApi(new TerminalApiError(statusCode, `HTTP ${statusCode}`)),
        );

        await expect(useCase.execute(makeRecord())).rejects.toBeInstanceOf(TerminalApiError);
      },
    );

    it('el error tiene el nombre correcto para que Step Functions lo capture', async () => {
      const useCase = new ProcessProviderRecordUseCase(
        new FakeProviderApi(new TerminalApiError(403, 'Forbidden')),
      );

      const error = await useCase.execute(makeRecord()).catch((e) => e);
      expect((error as Error).name).toBe('TerminalApiError');
      expect(JSON.parse((error as Error).message)).toMatchObject({
        statusCode: 403,
        category: 'TERMINAL',
      });
    });
  });

  describe('ERROR INESPERADO - bugs, fallos internos no clasificados', () => {
    it('propaga errores genericos sin reclasificarlos como TransientApiError', async () => {
      const useCase = new ProcessProviderRecordUseCase(
        new FakeProviderApi(new Error('ECONNRESET')),
      );

      await expect(useCase.execute(makeRecord())).rejects.toThrow('ECONNRESET');
      await expect(useCase.execute(makeRecord())).rejects.not.toBeInstanceOf(TransientApiError);
    });

    it('preserva el mensaje original para que Step Functions lo normalice como UNEXPECTED', async () => {
      const useCase = new ProcessProviderRecordUseCase(
        new FakeProviderApi(new Error('Connection refused')),
      );

      const error = await useCase.execute(makeRecord()).catch((e) => e) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('Error');
      expect(error.message).toContain('Connection refused');
    });

    it('normaliza fallos no-Error a Error generico', async () => {
      const useCase = new ProcessProviderRecordUseCase(
        {
          async call(): Promise<ProviderApiResult> {
            throw 'boom';
          },
        },
      );

      const error = await useCase.execute(makeRecord()).catch((e) => e) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('Unexpected non-error failure');
    });
  });
});

describe('classifyHttpError', () => {
  it.each([429, 502, 503, 504])(
    'clasifica %i como TransientApiError',
    (statusCode) => {
      const error = classifyHttpError(statusCode, 'body');
      expect(error).toBeInstanceOf(TransientApiError);
      expect(error.statusCode).toBe(statusCode);
      expect(JSON.parse(error.message)).toMatchObject({
        statusCode,
        category: 'TRANSIENT',
      });
    },
  );

  it.each([400, 401, 403, 404, 422, 500])(
    'clasifica %i como TerminalApiError',
    (statusCode) => {
      const error = classifyHttpError(statusCode, 'body');
      expect(error).toBeInstanceOf(TerminalApiError);
      expect(JSON.parse(error.message)).toMatchObject({
        statusCode,
        category: 'TERMINAL',
      });
    },
  );
});
