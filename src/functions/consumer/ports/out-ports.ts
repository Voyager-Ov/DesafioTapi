import { ProviderApiResult, ProviderRecord, ResultRecord } from '../../../shared/types';

// ---------------------------------------------------------------------------
// Consumer Output Ports
//
// Contratos que el Use Case necesita pero no implementa.
// Los Adapters (Fase 3) los implementan con los SDKs reales.
// Los Tests (Fase 2) los implementan con fakes en memoria.
// ---------------------------------------------------------------------------

/**
 * Puerto para llamar a la API externa del proveedor.
 * Implementación real: HttpProviderAdapter (usa axios/fetch).
 */
export interface IProviderApiPort {
  /**
   * Realiza la petición HTTP al proveedor.
   * @throws TransientApiError si el status code es recuperable (429, 503...)
   * @throws TerminalApiError si el status code es definitivo (400, 401...)
   */
  call(record: ProviderRecord): Promise<ProviderApiResult>;
}

/**
 * Puerto para persistir resultados en la base de datos.
 * Implementación real: DynamoDbResultRepository (Fase 3).
 */
export interface IResultRepositoryPort {
  /**
   * Guarda el resultado de una consulta al proveedor.
   * Construye PK/SK/TTL internamente en el adaptador.
   */
  save(result: ProviderApiResult): Promise<void>;

  /**
   * Guarda un registro de fallo terminal para auditoría.
   */
  saveFailure(record: ProviderRecord, error: { statusCode: number; message: string }): Promise<void>;
}
