import type { NotificationResult } from '../notifications/notifier';

export interface Appointment {
  id: string;
  callerName: string;
  callbackNumber: string;
  serviceSummary: string;
  requestedSlot: { date: string; timeWindow: string };
  status: 'demo';
  createdAt: string;
}

export interface Escalation {
  id: string;
  callbackNumber: string;
  situationSummary: string;
  location?: string;
  confirmed: boolean;
  createdAt: string;
}

type Channel = 'voice' | 'sms';

interface StoredRecord<T> {
  id: string;
  idempotencyKey: string;
  payloadHash: string;
  record: T;
  notificationResult: NotificationResult;
  channel: Channel;
  classification: string;
  createdAt: string;
}

export interface StoredRecordView<T = Appointment | Escalation> {
  id: string;
  idempotencyKey: string;
  payloadHash: string;
  record: T;
  notificationResult: NotificationResult;
  channel: Channel;
  classification: string;
  createdAt: string;
}

export interface Store {
  getByIdempotency(
    idempotencyKey: string,
  ): { payloadHash: string; record: Appointment | Escalation; notificationResult: NotificationResult } | undefined;
  saveAppointment(
    idempotencyKey: string,
    payloadHash: string,
    record: Appointment,
    notificationResult: NotificationResult,
    channel: Channel,
    classification: string,
  ): Appointment;
  saveEscalation(
    idempotencyKey: string,
    payloadHash: string,
    record: Escalation,
    notificationResult: NotificationResult,
    channel: Channel,
    classification: string,
  ): Escalation;
  getAppointment(id: string): Appointment | undefined;
  getEscalation(id: string): Escalation | undefined;
  getByRecordId(id: string): StoredRecordView | undefined;
  updateNotificationResult(idempotencyKey: string, notificationResult: NotificationResult): void;
  reset(): void;
}

function createStore(): Store {
  const appointments = new Map<string, StoredRecord<Appointment>>();
  const escalations = new Map<string, StoredRecord<Escalation>>();
  const byIdempotency = new Map<string, StoredRecord<Appointment | Escalation>>();

  const getStoredById = (id: string): StoredRecord<Appointment | Escalation> | undefined => {
    return appointments.get(id) ?? (escalations.get(id) as StoredRecord<Escalation> | undefined);
  };

  return {
    getByIdempotency(key) {
      const rec = byIdempotency.get(key);
      return rec
        ? { payloadHash: rec.payloadHash, record: rec.record, notificationResult: rec.notificationResult }
        : undefined;
    },
    saveAppointment(key, hash, record, notificationResult, channel, classification) {
      const stored: StoredRecord<Appointment> = {
        id: record.id,
        idempotencyKey: key,
        payloadHash: hash,
        record,
        notificationResult,
        channel,
        classification,
        createdAt: record.createdAt,
      };
      appointments.set(record.id, stored);
      byIdempotency.set(key, stored);
      return record;
    },
    saveEscalation(key, hash, record, notificationResult, channel, classification) {
      const stored: StoredRecord<Escalation> = {
        id: record.id,
        idempotencyKey: key,
        payloadHash: hash,
        record,
        notificationResult,
        channel,
        classification,
        createdAt: record.createdAt,
      };
      escalations.set(record.id, stored);
      byIdempotency.set(key, stored);
      return record;
    },
    getAppointment(id) {
      return appointments.get(id)?.record;
    },
    getEscalation(id) {
      return escalations.get(id)?.record;
    },
    getByRecordId(id) {
      return getStoredById(id);
    },
    updateNotificationResult(key, notificationResult) {
      const rec = byIdempotency.get(key);
      if (rec) {
        rec.notificationResult = notificationResult;
      }
    },
    reset() {
      appointments.clear();
      escalations.clear();
      byIdempotency.clear();
    },
  };
}

export const store = createStore();
