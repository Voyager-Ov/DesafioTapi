import {
  buildDispatchSlotMetadata,
  computeDispatchSlot,
  DEFAULT_DISPATCH_SLOTS_PER_DAY,
  formatDispatchSlotPk,
  formatDispatchSortKey,
} from '../../../src/functions/producer/domain/dispatch-slot-routing';
import { ProviderRecord } from '../../../src/shared/types';

function makeRecord(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    recordId: 'rec-001',
    providerId: 'prov-A',
    endpoint: 'https://api.example.com/resource',
    httpMethod: 'GET',
    scheduledDate: '2026-05-01',
    status: 'PENDING',
    ...overrides,
  };
}

describe('dispatch-slot-routing', () => {
  it('computes the same slot for the same record identity', () => {
    const record = makeRecord();

    expect(computeDispatchSlot(record)).toBe(computeDispatchSlot(record));
  });

  it('keeps the slot within the configured range', () => {
    const slot = computeDispatchSlot(makeRecord(), DEFAULT_DISPATCH_SLOTS_PER_DAY);

    expect(slot).toBeGreaterThanOrEqual(0);
    expect(slot).toBeLessThan(DEFAULT_DISPATCH_SLOTS_PER_DAY);
  });

  it('formats dispatchSlotPk with a zero-padded slot suffix', () => {
    expect(formatDispatchSlotPk('2026-05-01', 7, 288)).toBe('DATE#2026-05-01#SLOT#007');
  });

  it('formats dispatchSortKey with provider and record identity', () => {
    expect(formatDispatchSortKey('prov-A', 'rec-001')).toBe('PROVIDER#prov-A#RECORD#rec-001');
  });

  it('builds a full dispatch metadata payload from a record', () => {
    const record = makeRecord({ recordId: 'rec-777', providerId: 'prov-Z', scheduledDate: '2026-05-03' });

    const metadata = buildDispatchSlotMetadata(record);

    expect(metadata.dispatchDate).toBe('2026-05-03');
    expect(metadata.dispatchSlotPk).toMatch(/^DATE#2026-05-03#SLOT#\d{3}$/);
    expect(metadata.dispatchSortKey).toBe('PROVIDER#prov-Z#RECORD#rec-777');
  });

  it('rejects invalid slotsPerDay values', () => {
    expect(() => computeDispatchSlot(makeRecord(), 0)).toThrow('slotsPerDay must be a positive integer');
  });
});
