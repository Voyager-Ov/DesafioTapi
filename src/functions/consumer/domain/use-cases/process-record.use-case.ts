import { ProviderRecord } from '../../../../shared/types';
import { IProviderApiPort, IResultRepositoryPort } from '../../ports/out-ports';
import { TerminalApiError, TransientApiError } from '../errors/api.errors';

// ---------------------------------------------------------------------------
// ProcessProviderRecordUseCase
//
// Lógica de negocio del Consumer. Orquesta:
//   1. Llamar a la API del proveedor
//   2. Si éxito → guardar resultado
//   3. Si error transitorio → re-throw (Step Functions reintenta con backoff)
//   4. Si error terminal → guardar fallo + re-throw (Step Functions captura y alerta)
//
// Nada de AWS SDK. Nada de HTTP client. Solo dominio puro.
// ---------------------------------------------------------------------------
export class ProcessProviderRecordUseCase {
  constructor(
    private readonly providerApi: IProviderApiPort,
    private readonly resultRepository: IResultRepositoryPort,
  ) {}

  async execute(record: ProviderRecord): Promise<ProcessResult> {
    try {
      const result = await this.providerApi.call(record);

      await this.resultRepository.save(result);

      return {
        success: true,
        recordId: record.recordId,
        providerId: record.providerId,
        statusCode: result.statusCode,
        durationMs: result.durationMs,
      };
    } catch (error) {
      if (error instanceof TransientApiError) {
        // No guardamos nada — Step Functions va a reintentar el lambda completo.
        // Re-throw para que el bloque Retry de Step Functions lo detecte por nombre.
        throw error;
      }

      if (error instanceof TerminalApiError) {
        // Error definitivo: guardamos el fallo en DynamoDB para auditoría
        // y re-throw para que el bloque Catch de Step Functions lo capture.
        await this.resultRepository.saveFailure(record, {
          statusCode: (error as TerminalApiError).statusCode,
          message: (error as TerminalApiError).message,
        });
        throw error;
      }

      // Error inesperado (red, timeout de lambda, bug): lo tratamos como transitorio
      // para no perder el trabajo, pero lo re-lanzamos con contexto.
      throw new TransientApiError(
        0,
        `Unexpected error processing record ${record.recordId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export interface ProcessResult {
  readonly success: boolean;
  readonly recordId: string;
  readonly providerId: string;
  readonly statusCode: number;
  readonly durationMs: number;
}
