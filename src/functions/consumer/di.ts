import { HttpProviderAdapter } from './adapters/http-provider.adapter';
import { ProcessProviderRecordUseCase } from './domain/use-cases/process-record.use-case';

const providerApiTimeoutMs = Number(process.env.PROVIDER_API_TIMEOUT_MS ?? '15000');

export const providerApi = new HttpProviderAdapter(providerApiTimeoutMs);
export const processProviderRecordUseCase = new ProcessProviderRecordUseCase(
  providerApi,
);
