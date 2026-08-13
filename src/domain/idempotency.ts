import crypto from 'crypto';
import { store, Appointment, Escalation } from '../storage/store';
import type { NotificationResult } from '../notifications/notifier';

export type Channel = 'voice' | 'sms';

export function deriveStableIdempotencyKey(
  channel: Channel,
  sessionId: string,
  toolCallId: string,
): string {
  const raw = `${channel}:${sessionId}:${toolCallId}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function canonicalPayloadHash<T extends Record<string, unknown>>(payload: T): string {
  const copy = { ...payload } as Record<string, unknown>;
  delete copy.idempotencyKey;
  const sortedKeys = Object.keys(copy).sort();
  const normalized: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    normalized[key] = copy[key];
  }
  const json = JSON.stringify(normalized);
  return crypto.createHash('sha256').update(json).digest('hex');
}

export interface IdempotentResult<T> {
  status: 'new' | 'existing' | 'conflict';
  record?: T;
  notificationResult?: NotificationResult;
}

export function saveAppointmentWithIdempotency(
  key: string,
  payloadHash: string,
  record: Appointment,
  notificationResult: NotificationResult,
  channel: Channel,
  classification: string,
): IdempotentResult<Appointment> {
  const existing = store.getByIdempotency(key);
  if (existing) {
    if (existing.payloadHash === payloadHash) {
      return { status: 'existing', record: existing.record as Appointment, notificationResult: existing.notificationResult };
    }
    return { status: 'conflict' };
  }
  store.saveAppointment(key, payloadHash, record, notificationResult, channel, classification);
  return { status: 'new', record };
}

export function saveEscalationWithIdempotency(
  key: string,
  payloadHash: string,
  record: Escalation,
  notificationResult: NotificationResult,
  channel: Channel,
  classification: string,
): IdempotentResult<Escalation> {
  const existing = store.getByIdempotency(key);
  if (existing) {
    if (existing.payloadHash === payloadHash) {
      return { status: 'existing', record: existing.record as Escalation, notificationResult: existing.notificationResult };
    }
    return { status: 'conflict' };
  }
  store.saveEscalation(key, payloadHash, record, notificationResult, channel, classification);
  return { status: 'new', record };
}
