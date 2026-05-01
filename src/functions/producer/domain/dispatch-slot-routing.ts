import { DispatchSlotMetadata, ProviderRecord } from '../../../shared/types';
import { createHash } from 'crypto';

export const DEFAULT_DISPATCH_SLOTS_PER_DAY = 288;

export function buildDispatchSlotMetadata(
  record: Pick<ProviderRecord, 'recordId' | 'providerId' | 'scheduledDate'>,
  slotsPerDay = DEFAULT_DISPATCH_SLOTS_PER_DAY,
): DispatchSlotMetadata {
  const dispatchDate = record.scheduledDate;
  const dispatchSlot = computeDispatchSlot(record, slotsPerDay);

  return {
    dispatchDate,
    dispatchSlot,
    dispatchSlotPk: formatDispatchSlotPk(dispatchDate, dispatchSlot, slotsPerDay),
    dispatchSortKey: formatDispatchSortKey(record.providerId, record.recordId),
  };
}

export function computeDispatchSlot(
  record: Pick<ProviderRecord, 'recordId' | 'providerId' | 'scheduledDate'>,
  slotsPerDay = DEFAULT_DISPATCH_SLOTS_PER_DAY,
): number {
  validateSlotsPerDay(slotsPerDay);

  const hashInput = `${record.recordId}#${record.providerId}#${record.scheduledDate}`;
  const digest = createHash('sha256').update(hashInput).digest('hex');
  const hashPrefix = digest.slice(0, 8);
  const hashValue = Number.parseInt(hashPrefix, 16);

  return hashValue % slotsPerDay;
}

export function formatDispatchSlotPk(
  dispatchDate: string,
  dispatchSlot: number,
  slotsPerDay = DEFAULT_DISPATCH_SLOTS_PER_DAY,
): string {
  validateSlotsPerDay(slotsPerDay);

  return `DATE#${dispatchDate}#SLOT#${String(dispatchSlot).padStart(slotWidth(slotsPerDay), '0')}`;
}

export function formatDispatchSortKey(providerId: string, recordId: string): string {
  return `PROVIDER#${providerId}#RECORD#${recordId}`;
}

function slotWidth(slotsPerDay: number): number {
  return Math.max(3, String(slotsPerDay - 1).length);
}

function validateSlotsPerDay(slotsPerDay: number): void {
  if (!Number.isInteger(slotsPerDay) || slotsPerDay <= 0) {
    throw new Error(`slotsPerDay must be a positive integer. Received: ${slotsPerDay}`);
  }
}
