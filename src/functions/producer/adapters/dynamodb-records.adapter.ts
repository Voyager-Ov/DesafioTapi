import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { IRecordRepositoryPort } from '../ports/out-ports';
import { ProviderRecord } from '../../../shared/types';

// ---------------------------------------------------------------------------
// DynamoDbRecordsAdapter
//
// Secondary Adapter — reads ProviderRecord items from the
// `tapi-pending-records` DynamoDB table.
//
// Table access pattern used here:
//   PK = DATE#<YYYY-MM-DD>   → Query all records scheduled for a given day
//   SK begins_with RECORD#   → Scoped to the correct SK namespace
//
// Handles DynamoDB pagination automatically via the `LastEvaluatedKey` loop.
// ---------------------------------------------------------------------------
export class DynamoDbRecordsAdapter implements IRecordRepositoryPort {
  private readonly docClient: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    dynamoClient?: DynamoDBClient,
  ) {
    const client = dynamoClient ?? new DynamoDBClient({});
    this.docClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: {
        removeUndefinedValues: true,
        convertClassInstanceToMap: true,
      },
    });
  }

  async getPendingRecords(date: string): Promise<ProviderRecord[]> {
    const allRecords: ProviderRecord[] = [];
    let lastEvaluatedKey: Record<string, unknown> | undefined;

    do {
      const params: QueryCommandInput = {
        TableName: this.tableName,
        // Query by date partition
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        // Only return PENDING records
        FilterExpression: '#status = :pending',
        ExpressionAttributeNames: {
          '#status': 'status', // 'status' is not a reserved word but aliasing is safe practice
        },
        ExpressionAttributeValues: {
          ':pk': `DATE#${date}`,
          ':skPrefix': 'RECORD#',
          ':pending': 'PENDING',
        },
        // Continue from where we left off (pagination)
        ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey }),
      };

      const response = await this.docClient.send(new QueryCommand(params));

      const items = (response.Items ?? []) as ProviderRecord[];
      allRecords.push(...items);

      lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastEvaluatedKey !== undefined);

    return allRecords;
  }
}
