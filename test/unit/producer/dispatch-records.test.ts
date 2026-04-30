import { DispatchRecordsUseCase } from '../../../src/functions/producer/domain/use-cases/dispatch-records.use-case';
import { IQueuePort, IRecordRepositoryPort } from '../../../src/functions/producer/ports/out-ports';
import { ProviderRecord, SqsMessage } from '../../../src/shared/types';

// ---------------------------------------------------------------------------
// Fakes en memoria — implementan los puertos sin ningún SDK de AWS
// ---------------------------------------------------------------------------

class InMemoryRecordRepository implements IRecordRepositoryPort {
  constructor(private readonly records: ProviderRecord[] = []) {}

  async getPendingRecords(_date: string): Promise<ProviderRecord[]> {
    return this.records;
  }
}

class InMemoryQueue implements IQueuePort {
  public readonly sent: SqsMessage[] = [];

  async sendBatch(messages: SqsMessage[]): Promise<void> {
    this.sent.push(...messages);
  }
}

// ---------------------------------------------------------------------------
// Factories para reducir boilerplate en cada test
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    recordId: 'rec-001',
    providerId: 'prov-A',
    endpoint: 'https://api.proveedor.com/query',
    httpMethod: 'GET',
    scheduledDate: '2025-01-15',
    status: 'PENDING',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DispatchRecordsUseCase', () => {
  describe('cuando hay registros PENDING', () => {
    it('envía un mensaje SQS por cada registro', async () => {
      const records = [
        makeRecord({ recordId: 'rec-001', providerId: 'prov-A' }),
        makeRecord({ recordId: 'rec-002', providerId: 'prov-B' }),
      ];
      const queue = new InMemoryQueue();
      const useCase = new DispatchRecordsUseCase(
        new InMemoryRecordRepository(records),
        queue,
      );

      const result = await useCase.execute('2025-01-15');

      expect(result.dispatched).toBe(2);
      expect(queue.sent).toHaveLength(2);
    });

    it('asigna MessageGroupId = PROVIDER#<providerId>', async () => {
      const records = [makeRecord({ recordId: 'rec-001', providerId: 'prov-ACME' })];
      const queue = new InMemoryQueue();
      const useCase = new DispatchRecordsUseCase(
        new InMemoryRecordRepository(records),
        queue,
      );

      await useCase.execute('2025-01-15');

      expect(queue.sent[0].messageGroupId).toBe('PROVIDER#prov-ACME');
    });

    it('asigna MessageDeduplicationId = <recordId>#<scheduledDate>', async () => {
      const record = makeRecord({ recordId: 'rec-XYZ', scheduledDate: '2025-06-01' });
      const queue = new InMemoryQueue();
      const useCase = new DispatchRecordsUseCase(
        new InMemoryRecordRepository([record]),
        queue,
      );

      await useCase.execute('2025-06-01');

      expect(queue.sent[0].messageDeduplicationId).toBe('rec-XYZ#2025-06-01');
    });

    it('serializa el ProviderRecord completo en messageBody', async () => {
      const record = makeRecord();
      const queue = new InMemoryQueue();
      const useCase = new DispatchRecordsUseCase(
        new InMemoryRecordRepository([record]),
        queue,
      );

      await useCase.execute('2025-01-15');

      const body = JSON.parse(queue.sent[0].messageBody) as ProviderRecord;
      expect(body.recordId).toBe(record.recordId);
      expect(body.providerId).toBe(record.providerId);
      expect(body.endpoint).toBe(record.endpoint);
    });

    it('agrupa en batches de 10 cuando hay más de 10 registros', async () => {
      // SQS permite max 10 mensajes por SendMessageBatch
      const records = Array.from({ length: 25 }, (_, i) =>
        makeRecord({ recordId: `rec-${i}`, providerId: `prov-${i}` }),
      );
      const queue = new InMemoryQueue();
      const useCase = new DispatchRecordsUseCase(
        new InMemoryRecordRepository(records),
        queue,
      );

      const result = await useCase.execute('2025-01-15');

      // 25 registros → 3 batches (10 + 10 + 5), pero todos los mensajes llegan
      expect(queue.sent).toHaveLength(25);
      expect(result.dispatched).toBe(25);
    });
  });

  describe('cuando NO hay registros PENDING', () => {
    it('retorna dispatched=0 sin llamar a la cola', async () => {
      const queue = new InMemoryQueue();
      const useCase = new DispatchRecordsUseCase(
        new InMemoryRecordRepository([]),
        queue,
      );

      const result = await useCase.execute('2025-01-15');

      expect(result.dispatched).toBe(0);
      expect(queue.sent).toHaveLength(0);
    });
  });

  describe('cuando hay registros con status != PENDING', () => {
    it('omite los registros no PENDING y los cuenta como skipped', async () => {
      const mixed = [
        makeRecord({ recordId: 'rec-001', status: 'PENDING' }),
        makeRecord({ recordId: 'rec-002', status: 'FAILED' }),
        makeRecord({ recordId: 'rec-003', status: 'IN_PROGRESS' }),
      ];
      const queue = new InMemoryQueue();
      const useCase = new DispatchRecordsUseCase(
        new InMemoryRecordRepository(mixed),
        queue,
      );

      const result = await useCase.execute('2025-01-15');

      expect(result.dispatched).toBe(1);
      expect(result.skipped).toBe(2);
      expect(queue.sent).toHaveLength(1);
    });
  });

  describe('propagación de errores', () => {
    it('propaga el error si la cola falla', async () => {
      const records = [makeRecord()];
      const failingQueue: IQueuePort = {
        async sendBatch() {
          throw new Error('SQS connection timeout');
        },
      };
      const useCase = new DispatchRecordsUseCase(
        new InMemoryRecordRepository(records),
        failingQueue,
      );

      await expect(useCase.execute('2025-01-15')).rejects.toThrow('SQS connection timeout');
    });

    it('propaga el error si el repositorio falla', async () => {
      const failingRepo: IRecordRepositoryPort = {
        async getPendingRecords() {
          throw new Error('DynamoDB read error');
        },
      };
      const useCase = new DispatchRecordsUseCase(failingRepo, new InMemoryQueue());

      await expect(useCase.execute('2025-01-15')).rejects.toThrow('DynamoDB read error');
    });
  });
});
