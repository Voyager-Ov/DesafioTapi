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

      // Unexpected internal/runtime failures must surface as generic errors so
      // Step Functions can route them through the UNEXPECTED path via States.ALL.
      if (error instanceof Error) {
        throw error;
      }

      throw new Error(
        `Unexpected non-error failure processing record ${record.recordId}: ${String(error)}`,
      );
    }
  }
}

export type ProcessResult = ProviderApiResult;
