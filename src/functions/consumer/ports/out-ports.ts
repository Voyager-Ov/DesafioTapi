import { ProviderApiResult, ProviderRecord } from '../../../shared/types';

export interface IProviderApiPort {
  call(record: ProviderRecord): Promise<ProviderApiResult>;
}
