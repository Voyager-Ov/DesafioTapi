import { DynamoDbResultRepository } from './adapters/dynamodb-result.repository';
import { HttpProviderAdapter } from './adapters/http-provider.adapter';
import { ProcessProviderRecordUseCase } from './domain/use-cases/process-record.use-case';

const resultsTableName = process.env.RESULTS_TABLE_NAME ?? requireEnv('RESULTS_TABLE_NAME');
const providerApiTimeoutMs = Number(process.env.PROVIDER_API_TIMEOUT_MS ?? '15000');

export const providerApi = new HttpProviderAdapter(providerApiTimeoutMs);
export const resultRepository = new DynamoDbResultRepository(resultsTableName);
export const processProviderRecordUseCase = new ProcessProviderRecordUseCase(
  providerApi,
  resultRepository,
);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
