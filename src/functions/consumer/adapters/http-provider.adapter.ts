import { classifyHttpError, TerminalApiError } from '../domain/errors/api.errors';
import { IProviderApiPort } from '../ports/out-ports';
import { ProviderApiResult, ProviderRecord } from '../../../shared/types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class HttpProviderAdapter implements IProviderApiPort {
  constructor(
    private readonly timeoutMs = 15000,
    private readonly fetchFn: FetchLike = globalThis.fetch.bind(globalThis),
  ) {}

  async call(record: ProviderRecord): Promise<ProviderApiResult> {
    this.assertHttpsEndpoint(record.endpoint);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await this.fetchFn(record.endpoint, {
        method: record.httpMethod,
        headers: {
          'content-type': 'application/json',
          ...(record.headers ?? {}),
        },
        body: this.buildBody(record),
        signal: controller.signal,
      });

      const rawBody = await this.readBody(response);

      if (!response.ok) {
        throw classifyHttpError(response.status, rawBody);
      }

      return {
        recordId: record.recordId,
        providerId: record.providerId,
        statusCode: response.status,
        responseBody: this.serializeResponseBody(rawBody),
        durationMs: Date.now() - startedAt,
        processedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw classifyHttpError(504, `Request timed out after ${this.timeoutMs}ms`);
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private assertHttpsEndpoint(endpoint: string): void {
    let parsedUrl: URL;

    try {
      parsedUrl = new URL(endpoint);
    } catch {
      throw new TerminalApiError(400, `Invalid provider endpoint: ${endpoint}`);
    }

    if (parsedUrl.protocol !== 'https:') {
      throw new TerminalApiError(
        400,
        `Provider endpoint must use HTTPS: ${endpoint}`,
      );
    }
  }

  private buildBody(record: ProviderRecord): string | undefined {
    if (record.httpMethod === 'GET') {
      return undefined;
    }

    return JSON.stringify(record.payload ?? {});
  }

  private async readBody(response: Response): Promise<string> {
    return response.text();
  }

  private serializeResponseBody(body: string): string {
    try {
      if (!body) {
        return '';
      }

      return JSON.stringify(JSON.parse(body));
    } catch {
      return body;
    }
  }
}
