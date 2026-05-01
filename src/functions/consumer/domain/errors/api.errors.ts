// ---------------------------------------------------------------------------
// Domain Errors
//
// Estos errores son el "idioma" que usa el dominio para comunicarle al mundo
// exterior (Step Functions) qué tipo de falla ocurrió.
//
// Step Functions los distingue por el campo `name` del error:
//   - TransientApiError → bloque Retry (reintentar con backoff exponencial)
//   - TerminalApiError  → bloque Catch (abortar y alertar)
//
// Son 100% TypeScript puro — sin dependencias AWS.
// ---------------------------------------------------------------------------

export class TransientApiError extends Error {
  public readonly name = 'TransientApiError';
  public readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(serializeApiErrorPayload(statusCode, message, 'TRANSIENT'));
    this.statusCode = statusCode;
    // Fix prototype chain (necesario cuando se extiende Error en TypeScript)
    Object.setPrototypeOf(this, TransientApiError.prototype);
  }
}

export class TerminalApiError extends Error {
  public readonly name = 'TerminalApiError';
  public readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(serializeApiErrorPayload(statusCode, message, 'TERMINAL'));
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, TerminalApiError.prototype);
  }
}

/**
 * Clasifica un HTTP status code en TRANSIENT o TERMINAL.
 *
 * TRANSIENT (reintentar): el proveedor está saturado o caído temporalmente.
 * TERMINAL (abortar): el request tiene un error lógico que no se resuelve reintentando.
 */
export function classifyHttpError(
  statusCode: number,
  body: string,
): TransientApiError | TerminalApiError {
  if (TRANSIENT_CODES.has(statusCode)) {
    return new TransientApiError(
      statusCode,
      `Transient error from provider (HTTP ${statusCode}): ${body}`,
    );
  }

  return new TerminalApiError(
    statusCode,
    `Terminal error from provider (HTTP ${statusCode}): ${body}`,
  );
}

// 429 Too Many Requests, 503 Service Unavailable, 502 Bad Gateway, 504 Gateway Timeout
const TRANSIENT_CODES = new Set([429, 502, 503, 504]);

function serializeApiErrorPayload(
  statusCode: number,
  message: string,
  category: 'TRANSIENT' | 'TERMINAL',
): string {
  return JSON.stringify({
    statusCode,
    message,
    category,
  });
}
