import { ProviderApiResult, ProviderRecord } from '../../../../shared/types';
import { IProviderApiPort } from '../../ports/out-ports';
import { TerminalApiError, TransientApiError } from '../errors/api.errors';

export class ProcessProviderRecordUseCase {
  constructor(
    private readonly providerApi: IProviderApiPort,
  ) {}

  async execute(record: ProviderRecord): Promise<ProcessResult> {
    try {
      return await this.providerApi.call(record);
    } catch (error) {
      if (error instanceof TransientApiError || error instanceof TerminalApiError) {
        throw error;
      }

      throw new TransientApiError(
        0,
        `Unexpected error processing record ${record.recordId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

export type ProcessResult = ProviderApiResult;
