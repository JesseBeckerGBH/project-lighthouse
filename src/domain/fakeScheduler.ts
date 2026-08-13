import crypto from 'crypto';
import { Result, ok, err } from '../errors';

export interface Slot {
  date: string;
  timeWindow: string;
}

export interface FakeAppointment {
  id: string;
  callerName: string;
  callbackNumber: string;
  serviceSummary: string;
  requestedSlot: Slot;
  status: 'demo';
  createdAt: string;
}

const ALLOWED_WINDOWS = ['morning', 'afternoon', '9 AM - 12 PM', '1 PM - 5 PM'];

export function validateSlot(slot: Slot): Result<null> {
  if (!slot || !slot.date || slot.date.trim() === '' || !slot.timeWindow || slot.timeWindow.trim() === '') {
    return err('VALIDATION_ERROR', 'A requested slot is required.', [
      { field: 'requestedSlot', code: 'REQUIRED' },
    ]);
  }
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(slot.date)) {
    return err('VALIDATION_ERROR', 'Requested date must be in YYYY-MM-DD format.', [
      { field: 'requestedSlot.date', code: 'INVALID_FORMAT' },
    ]);
  }
  const requested = new Date(slot.date + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (Number.isNaN(requested.getTime()) || requested < today) {
    return err('VALIDATION_ERROR', 'Requested date must be today or in the future.', [
      { field: 'requestedSlot.date', code: 'PAST_DATE' },
    ]);
  }
  const maxDate = new Date(today);
  maxDate.setDate(maxDate.getDate() + 14);
  if (requested > maxDate) {
    return err('VALIDATION_ERROR', 'Requested date is outside demo availability window.', [
      { field: 'requestedSlot.date', code: 'OUTSIDE_WINDOW' },
    ]);
  }
  const timeWindow = slot.timeWindow.trim();
  const normalized = timeWindow.toLowerCase();
  if (
    !ALLOWED_WINDOWS.includes(normalized) &&
    !timeWindow.includes('AM') &&
    !timeWindow.includes('PM')
  ) {
    return err('VALIDATION_ERROR', 'Requested time window is not available.', [
      { field: 'requestedSlot.timeWindow', code: 'INVALID_WINDOW' },
    ]);
  }
  return ok(null);
}

export function createFakeAppointment(
  callerName: string,
  callbackNumber: string,
  serviceSummary: string,
  requestedSlot: Slot,
): FakeAppointment {
  return {
    id: `apt-${crypto.randomBytes(8).toString('hex')}`,
    callerName,
    callbackNumber,
    serviceSummary,
    requestedSlot,
    status: 'demo',
    createdAt: new Date().toISOString(),
  };
}
