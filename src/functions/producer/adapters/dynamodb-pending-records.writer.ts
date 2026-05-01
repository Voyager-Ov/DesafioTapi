import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  PutCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { buildDispatchSlotMetadata, DEFAULT_DISPATCH_SLOTS_PER_DAY } from '../domain/dispatch-slot-routing';
import { PendingRecordItem, PendingRecordWriteInput } from '../../../shared/types';

export class DynamoDbPendingRecordsWriter {
  private readonly docClient: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    private readonly slotsPerDay = DEFAULT_DISPATCH_SLOTS_PER_DAY,
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

  buildItem(record: PendingRecordWriteInput): PendingRecordItem {
    const routing = buildDispatchSlotMetadata(record, this.slotsPerDay);

    return {
      PK: `DATE#${record.scheduledDate}`,
      SK: `RECORD#${record.recordId}`,
      ...record,
      ...routing,
    };
  }

  async put(record: PendingRecordWriteInput): Promise<PendingRecordItem> {
    const item = this.buildItem(record);

    const params: PutCommandInput = {
      TableName: this.tableName,
      Item: item,
    };

    await this.docClient.send(new PutCommand(params));
    return item;
  }
}
