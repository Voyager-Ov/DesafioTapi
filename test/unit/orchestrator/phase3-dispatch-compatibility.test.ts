import { SQSEvent } from 'aws-lambda';
import { DispatchRecordsUseCase } from '../../../src/functions/producer/domain/use-cases/dispatch-records.use-case';
import { buildDispatchSlotMetadata, DEFAULT_DISPATCH_SLOTS_PER_DAY } from '../../../src/functions/producer/domain/dispatch-slot-routing';
import { IQueuePort, IRecordRepositoryPort } from '../../../src/functions/producer/ports/out-ports';
import { PendingDispatchRecord, ProviderRecord, SqsMessage } from '../../../src/shared/types';

jest.mock('@aws-sdk/client-stepfunctions', () => {
  return {
    StepFunctionsClient: function () {
      return { send: jest.fn() };
    },
    StartExecutionCommand: function (input: unknown) {
      return input;
    },
  };
});

process.env.STATE_MACHINE_ARN = 'arn:local:stateMachine:test';
const { handler, sfnClient } = require('../../../src/functions/orchestrator/handler');

class InMemoryRecordRepository implements IRecordRepositoryPort {
  constructor(private readonly records: PendingDispatchRecord[]) {}

  async getPendingRecordsForSlot(): Promise<PendingDispatchRecord[]> {
    return this.records;
  }
}

class InMemoryQueue implements IQueuePort {
  public readonly sent: SqsMessage[] = [];

  async sendBatch(messages: SqsMessage[]): Promise<void> {
    this.sent.push(...messages);
  }
}

function makeRecord(overrides: Partial<ProviderRecord> = {}): PendingDispatchRecord {
  const baseRecord: ProviderRecord = {
    recordId: 'rec-201',
    providerId: 'prov-A',
    endpoint: 'https://httpbin.org/status/200',
    httpMethod: 'GET',
    scheduledDate: '2026-04-30',
    status: 'PENDING',
    ...overrides,
  };

  return {
    ...baseRecord,
    ...buildDispatchSlotMetadata(baseRecord, DEFAULT_DISPATCH_SLOTS_PER_DAY),
  };
}

describe('phase 3 producer to orchestrator compatibility', () => {
  beforeEach(() => jest.resetAllMocks());

  it('keeps the phase-2 queue payload contract intact for downstream consumers', async () => {
    sfnClient.send = jest.fn().mockResolvedValue({});

    const queue = new InMemoryQueue();
    const producerUseCase = new DispatchRecordsUseCase(
      new InMemoryRecordRepository([makeRecord()]),
      queue,
    );

    await producerUseCase.execute({
      targetDate: '2026-04-30',
      slotId: 149,
      slotsPerDay: DEFAULT_DISPATCH_SLOTS_PER_DAY,
    });

    expect(queue.sent).toHaveLength(1);

    const event: SQSEvent = {
      Records: [
        {
          messageId: 'm1',
          receiptHandle: 'r1',
          body: queue.sent[0].messageBody,
          attributes: {},
          messageAttributes: {},
          md5OfBody: '',
          eventSource: 'aws:sqs',
          eventSourceARN: '',
          awsRegion: 'us-east-1',
        },
      ],
    } as unknown as SQSEvent;

    const result = await handler(event, {} as never);

    expect(result).toEqual({});
    expect(sfnClient.send).toHaveBeenCalledTimes(1);

    const executionInput = JSON.parse(sfnClient.send.mock.calls[0][0].input);
    expect(executionInput.workItem).toEqual({
      recordId: 'rec-201',
      providerId: 'prov-A',
      endpoint: 'https://httpbin.org/status/200',
      httpMethod: 'GET',
      payload: {},
      headers: {},
      scheduledDate: '2026-04-30',
      status: 'PENDING',
    });
    expect(executionInput.workflow).toEqual({
      idempotencyTtl: expect.any(String),
      resultsTtl: expect.any(String),
    });
  });
});
