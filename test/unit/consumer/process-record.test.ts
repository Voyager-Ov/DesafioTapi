import { ProcessProviderRecordUseCase } from '../../../src/functions/consumer/domain/use-cases/process-record.use-case';
import { IProviderApiPort, IResultRepositoryPort } from '../../../src/functions/consumer/ports/out-ports';
import { TerminalApiError, TransientApiError } from '../../../src/functions/consumer/domain/errors/api.errors';
import { ProviderApiResult, ProviderRecord } from '../../../src/shared/types';

// ---------------------------------------------------------------------------
// Fakes en memoria
// ---------------------------------------------------------------------------

class FakeProviderApi implements IProviderApiPort {
  constructor(
    private readonly response: ProviderApiResult | Error,
  ) {}

  async call(_record: ProviderRecord): Promise<ProviderApiResult> {
    if (this.response instanceof Error) throw this.response;
    return this.response;
  }
}

class FakeResultRepository implements IResultRepositoryPort {
  public readonly saved: ProviderApiResult[] = [];
  public readonly savedFailures: Array<{ record: ProviderRecord; error: { statusCode: number; message: string } }> = [];

  async save(result: ProviderApiResult): Promise<void> {
    this.saved.push(result);
  }

  async saveFailure(
    record: ProviderRecord,
    error: { statusCode: number; message: string },
  ): Promise<void> {
    this.savedFailures.push({ record, error });
  }
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

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
    responseBody: { data: 'ok' },
    durationMs: 123,
    processedAt: '2025-01-15T10:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProcessProviderRecordUseCase', () => {
  describe('HAPPY PATH — API responde exitosamente', () => {
    it('guarda el resultado en el repositorio', async () => {
      const apiResult = makeApiResult();
      const repo = new FakeResultRepository();
      const useCase = new ProcessProviderRecordUseCase(
        new FakeProviderApi(apiResult),
        repo,
      );

      await useCase.execute(makeRecord());

      expect(repo.saved).toHaveLength(1);
      expect(repo.saved[0].recordId).toBe('rec-001');
      expect(repo.saved[0].statusCode).toBe(200);
    });

    it('retorna ProcessResult con success=true', async () => {
      const apiResult = makeApiResult({ durationMs: 456, statusCode: 200 });
      const useCase = new ProcessProviderRecordUseCase(
        new FakeProviderApi(apiResult),
        new FakeResultRepository(),
      );

      const result = await useCase.execute(makeRecord());

      expect(result.success).toBe(true);
      expect(result.durationMs).toBe(456);
      expect(result.statusCode).toBe(200);
    });

    it('NO guarda ningún fallo cuando la API tiene éxito', async () => {
      const repo = new FakeResultRepository();
      const useCase = new ProcessProviderRecordUseCase(
        new FakeProviderApi(makeApiResult()),
        repo,
      );

      await useCase.execute(makeRecord());

      expect(repo.savedFailures).toHaveLength(0);
    });
  });

  describe('ERROR TRANSITORIO — 429, 503 (reintentar)', () => {
    it.each([429, 502, 503, 504])(
      'lanza TransientApiError para HTTP %i (sin guardar fallo)',
      async (statusCode) => {
        const repo = new FakeResultRepository();
        const useCase = new ProcessProviderRecordUseCase(
          new FakeProviderApi(new TransientApiError(statusCode, `HTTP ${statusCode}`)),
          repo,
        );

        await expect(useCase.execute(makeRecord())).rejects.toBeInstanceOf(TransientApiError);
        // NO debe guardar nada — Step Functions reintentará la lambda completa
        expect(repo.saved).toHaveLength(0);
        expect(repo.savedFailures).toHaveLength(0);
      },
    );

    it('el error tiene el nombre correcto para que Step Functions lo detecte', async () => {
      const useCase = new ProcessProviderRecordUseCase(
        new FakeProviderApi(new TransientApiError(429, 'rate limited')),
        new FakeResultRepository(),
      );

      const error = await useCase.execute(makeRecord()).catch((e) => e);

      // Step Functions usa error.name para matchear el bloque Retry
      expect((error as Error).name).toBe('TransientApiError');
    });
  });

  describe('ERROR TERMINAL — 400, 401, 403 (abortar y alertar)', () => {
    it.each([400, 401, 403, 404])(
      'lanza TerminalApiError para HTTP %i',
      async (statusCode) => {
        const useCase = new ProcessProviderRecordUseCase(
          new FakeProviderApi(new TerminalApiError(statusCode, `HTTP ${statusCode}`)),
          new FakeResultRepository(),
        );

        await expect(useCase.execute(makeRecord())).rejects.toBeInstanceOf(TerminalApiError);
      },
    );

    it('guarda el fallo en el repositorio antes de re-throw', async () => {
      const repo = new FakeResultRepository();
      const record = makeRecord({ recordId: 'rec-999', providerId: 'prov-X' });
      const useCase = new ProcessProviderRecordUseCase(
        new FakeProviderApi(new TerminalApiError(401, 'Unauthorized')),
        repo,
      );

      await useCase.execute(record).catch(() => {/* esperado */});

      expect(repo.savedFailures).toHaveLength(1);
      expect(repo.savedFailures[0].record.recordId).toBe('rec-999');
      expect(repo.savedFailures[0].error.statusCode).toBe(401);
    });

    it('NO guarda resultado exitoso en un error terminal', async () => {
      const repo = new FakeResultRepository();
      const useCase = new ProcessProviderRecordUseCase(
        new FakeProviderApi(new TerminalApiError(400, 'Bad Request')),
        repo,
      );

      await useCase.execute(makeRecord()).catch(() => {/* esperado */});

      expect(repo.saved).toHaveLength(0);
    });

    it('el error tiene el nombre correcto para que Step Functions lo capture', async () => {
      const useCase = new ProcessProviderRecordUseCase(
        new FakeProviderApi(new TerminalApiError(403, 'Forbidden')),
        new FakeResultRepository(),
      );

      const error = await useCase.execute(makeRecord()).catch((e) => e);

      // Step Functions usa error.name para matchear el bloque Catch
      expect((error as Error).name).toBe('TerminalApiError');
    });
  });

  describe('ERROR INESPERADO — bugs, timeouts de red', () => {
    it('convierte errores genéricos en TransientApiError para no perder el trabajo', async () => {
      const useCase = new ProcessProviderRecordUseCase(
        new FakeProviderApi(new Error('ECONNRESET')),
        new FakeResultRepository(),
      );

      const error = await useCase.execute(makeRecord()).catch((e) => e);

      // Errores de red se tratan como transitorios → Step Functions reintenta
      expect((error as Error).name).toBe('TransientApiError');
    });

    it('incluye el mensaje original en el error envuelto', async () => {
      const useCase = new ProcessProviderRecordUseCase(
        new FakeProviderApi(new Error('Connection refused')),
        new FakeResultRepository(),
      );

      const error = await useCase.execute(makeRecord()).catch((e) => e) as TransientApiError;

      expect(error.message).toContain('Connection refused');
    });
  });
});

// ---------------------------------------------------------------------------
// Tests para classifyHttpError (función pura de dominio)
// ---------------------------------------------------------------------------

describe('classifyHttpError', () => {
  const { classifyHttpError } = require('../../../src/functions/consumer/domain/errors/api.errors');

  it.each([429, 502, 503, 504])(
    'clasifica %i como TransientApiError',
    (statusCode) => {
      const error = classifyHttpError(statusCode, 'body');
      expect(error).toBeInstanceOf(TransientApiError);
      expect(error.statusCode).toBe(statusCode);
    },
  );

  it.each([400, 401, 403, 404, 422, 500])(
    'clasifica %i como TerminalApiError',
    (statusCode) => {
      const error = classifyHttpError(statusCode, 'body');
      expect(error).toBeInstanceOf(TerminalApiError);
    },
  );
});
