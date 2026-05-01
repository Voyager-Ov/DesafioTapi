import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  PutCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { ProviderApiResult, ProviderRecord, ResultRecord } from '../../../shared/types';

const TTL_DAYS = Number(process.env.TTL_DAYS ?? '90');

export class DynamoDbResultRepository {
  private readonly docClient: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    dynamoClient?: DynamoDBClient,
    docClient?: DynamoDBDocumentClient,
  ) {
    if (docClient) {
      this.docClient = docClient;
      return;
    }

    const client = dynamoClient ?? new DynamoDBClient({});
    this.docClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: {
        removeUndefinedValues: true,
        convertClassInstanceToMap: true,
      },
    });
  }

  async save(result: ProviderApiResult): Promise<void> {
    const item = this.buildSuccessItem(result);
    await this.putItem(item);
  }

  async saveFailure(
    record: ProviderRecord,
    error: { statusCode: number; message: string },
  ): Promise<void> {
    const processedAt = new Date().toISOString();
    const item: ResultRecord = {
      PK: `PROVIDER#${record.providerId}`,
      SK: `TIMESTAMP#${processedAt}#${record.recordId}`,
      recordId: record.recordId,
      providerId: record.providerId,
      statusCode: error.statusCode,
      responseBody: JSON.stringify({
        error: error.message,
        status: error.statusCode,
      }),
      durationMs: 0,
      processedAt,
      ttl: this.buildTtl(processedAt),
    };

    await this.putItem(item);
  }

  private buildSuccessItem(result: ProviderApiResult): ResultRecord {
    return {
      PK: `PROVIDER#${result.providerId}`,
      SK: `TIMESTAMP#${result.processedAt}#${result.recordId}`,
      recordId: result.recordId,
      providerId: result.providerId,
      statusCode: result.statusCode,
      responseBody: result.responseBody,
      durationMs: result.durationMs,
      processedAt: result.processedAt,
      ttl: this.buildTtl(result.processedAt),
    };
  }

  private buildTtl(processedAtIso: string): number {
    const processedAtMs = new Date(processedAtIso).getTime();
    return Math.floor((processedAtMs + TTL_DAYS * 24 * 60 * 60 * 1000) / 1000);
  }

  private async putItem(item: ResultRecord): Promise<void> {
    const params: PutCommandInput = {
      TableName: this.tableName,
      Item: item,
    };

    await this.docClient.send(new PutCommand(params));
  }
}
