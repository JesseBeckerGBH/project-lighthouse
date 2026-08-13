import { describe, it, expect, beforeEach } from 'vitest';
import { getConfig } from '../src/config';
import { store } from '../src/storage/store';
import { classify } from '../src/domain/classifier';
import { answerBusinessQuestion } from '../src/domain/faq';
import {
  classifyCall,
  answerBusinessFact,
  scheduleAppointment,
  escalateEmergency,
  retryOwnerNotification,
  AppointmentInput,
  EscalationInputFull,
} from '../src/domain/service';
import { deriveStableIdempotencyKey, canonicalPayloadHash } from '../src/domain/idempotency';
import { generateRequestId } from '../src/errors';
import type { Notifier } from '../src/notifications/notifier';

const baseAppointment: AppointmentInput = {
  channel: 'sms',
  sessionId: 'session-1',
  toolCallId: 'tc-1',
  callerName: 'Alice',
  callbackNumber: '+15551234567',
  serviceSummary: 'Leak repair',
  requestedSlot: { date: new Date(Date.now() + 86400000).toISOString().split('T')[0], timeWindow: 'morning' },
  confirmed: false,
};

const baseEscalation: EscalationInputFull = {
  channel: 'sms',
  sessionId: 'session-1',
  toolCallId: 'tc-2',
  callbackNumber: '+15551234567',
  situationSummary: 'There is a fire in the kitchen',
  confirmed: false,
};

const failingNotifier: Notifier = async () => ({ ok: false, error: 'SMS gateway unavailable' });

describe('domain layer', () => {
  beforeEach(() => {
    store.reset();
  });

  describe('classify', () => {
    it('classifies EMERGENCY from safety keywords', () => {
      const result = classify('I smell gas and there is a leak');
      expect(result.intent).toBe('EMERGENCY');
    });

    it('classifies NEW_LEAD from service request', () => {
      const result = classify('I need a quote for a new installation');
      expect(result.intent).toBe('NEW_LEAD');
    });

    it('classifies EXISTING_CUSTOMER from follow-up language', () => {
      const result = classify('I want the status of my existing appointment');
      expect(result.intent).toBe('EXISTING_CUSTOMER');
    });

    it('defaults to GENERAL_QUESTION when no strong signal', () => {
      const result = classify('What is your address?');
      expect(result.intent).toBe('GENERAL_QUESTION');
    });
  });

  describe('answerBusinessQuestion', () => {
    it('answers configured hours', () => {
      const result = answerBusinessQuestion('What are your hours?');
      expect(result.ok).toBe(true);
      expect(result.data).toBe(getConfig().businessHours);
    });

    it('answers configured service area', () => {
      const result = answerBusinessQuestion('What area do you serve?');
      expect(result.ok).toBe(true);
      expect(result.data).toBe(getConfig().businessServiceArea);
    });

    it('answers configured business name', () => {
      const result = answerBusinessQuestion('What is your business name?');
      expect(result.ok).toBe(true);
      expect(result.data).toBe(getConfig().businessName);
    });

    it('returns FACT_NOT_CONFIGURED for unknown facts', () => {
      const result = answerBusinessQuestion('Do you install solar panels?');
      expect(result.ok).toBe(false);
      expect(result.code).toBe('FACT_NOT_CONFIGURED');
    });
  });

  describe('idempotency', () => {
    it('derives stable idempotency key from session and tool call only', () => {
      const key1 = deriveStableIdempotencyKey('voice', 'call-1', 'tool-1');
      const key2 = deriveStableIdempotencyKey('voice', 'call-1', 'tool-1');
      const key3 = deriveStableIdempotencyKey('voice', 'call-1', 'tool-2');
      expect(key1).toBe(key2);
      expect(key1).not.toBe(key3);
    });

    it('produces different keys for different sessions even with same tool', () => {
      const key1 = deriveStableIdempotencyKey('voice', 'call-1', 'tool-1');
      const key2 = deriveStableIdempotencyKey('voice', 'call-2', 'tool-1');
      expect(key1).not.toBe(key2);
    });

    it('canonical payload hash is stable and detects changes', () => {
      const a = canonicalPayloadHash({ callerName: 'Alice', confirmed: true });
      const b = canonicalPayloadHash({ callerName: 'Alice', confirmed: true });
      const c = canonicalPayloadHash({ callerName: 'Bob', confirmed: true });
      expect(a).toBe(b);
      expect(a).not.toBe(c);
    });

    it('ignores idempotency_key in payload hash', () => {
      const a = canonicalPayloadHash({ callerName: 'Alice', idempotencyKey: 'one' });
      const b = canonicalPayloadHash({ callerName: 'Alice', idempotencyKey: 'two' });
      expect(a).toBe(b);
    });
  });

  describe('scheduleAppointment', () => {
    it('requires explicit confirmation before write', async () => {
      const result = await scheduleAppointment({ ...baseAppointment, confirmed: false }, 'req-1');
      expect(result.ok).toBe(false);
      expect(result.code).toBe('CONFIRMATION_REQUIRED');
      expect(store.getByIdempotency(deriveStableIdempotencyKey('sms', 'session-1', 'tc-1'))).toBeUndefined();
    });

    it('creates a fake demo appointment after confirmation', async () => {
      const result = await scheduleAppointment({ ...baseAppointment, confirmed: true }, 'req-2');
      expect(result.ok).toBe(true);
      expect(result.data).not.toBeNull();
      expect((result.data as any).appointment.status).toBe('demo');
    });

    it('returns the original result on an identical retry', async () => {
      const result1 = await scheduleAppointment({ ...baseAppointment, confirmed: true }, 'req-3');
      const result2 = await scheduleAppointment({ ...baseAppointment, confirmed: true }, 'req-3');
      expect((result1.data as any).appointment.id).toBe((result2.data as any).appointment.id);
    });

    it('returns CONFLICT on same key with different payload', async () => {
      await scheduleAppointment({ ...baseAppointment, confirmed: true }, 'req-4');
      const changed = { ...baseAppointment, callerName: 'Bob', confirmed: true };
      const result = await scheduleAppointment(changed, 'req-5');
      expect(result.ok).toBe(false);
      expect(result.code).toBe('CONFLICT');
    });

    it('preserves the appointment when owner notification fails', async () => {
      const result = await scheduleAppointment(
        { ...baseAppointment, confirmed: true },
        'req-6',
        failingNotifier,
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('UPSTREAM_ERROR');
      const appointment = (result.data as any)?.appointment;
      const notification = (result.data as any)?.notification;
      expect(appointment).toBeDefined();
      expect(notification.ok).toBe(false);
      expect(store.getAppointment(appointment.id)).toBeDefined();
    });

    it('returns the original failed notification result on an identical retry without duplicating or re-notifying', async () => {
      let calls = 0;
      const countingFailingNotifier: typeof failingNotifier = async () => {
        calls += 1;
        return { ok: false, error: 'SMS gateway unavailable' };
      };
      const input = { ...baseAppointment, confirmed: true };
      const result1 = await scheduleAppointment(input, 'req-6a', countingFailingNotifier);
      const result2 = await scheduleAppointment(input, 'req-6b', countingFailingNotifier);
      expect(result1.ok).toBe(false);
      expect(result2.ok).toBe(false);
      expect((result1.data as any).appointment.id).toBe((result2.data as any).appointment.id);
      expect((result2.data as any).notification.ok).toBe(false);
      expect(calls).toBe(1);
    });

    it('validates the requested slot', async () => {
      const badSlot = { ...baseAppointment, confirmed: true, requestedSlot: { date: 'not-a-date', timeWindow: 'morning' } };
      const result = await scheduleAppointment(badSlot, 'req-7');
      expect(result.ok).toBe(false);
      expect(result.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('escalateEmergency', () => {
    it('records an escalation even when confirmed is false', async () => {
      const result = await escalateEmergency(baseEscalation, 'req-8');
      expect(result.ok).toBe(true);
      expect((result.data as any).escalation).toBeDefined();
      const id = (result.data as any).escalation.id;
      expect(store.getEscalation(id)).toBeDefined();
    });

    it('records an escalation when confirmed is true', async () => {
      const result = await escalateEmergency({ ...baseEscalation, confirmed: true }, 'req-9');
      expect(result.ok).toBe(true);
      expect((result.data as any).escalation).toBeDefined();
    });

    it('returns the original result on an identical retry', async () => {
      const result1 = await escalateEmergency(baseEscalation, 'req-10');
      const result2 = await escalateEmergency(baseEscalation, 'req-10');
      expect((result1.data as any).escalation.id).toBe((result2.data as any).escalation.id);
    });

    it('returns CONFLICT on same key with different payload', async () => {
      await escalateEmergency(baseEscalation, 'req-11');
      const changed = { ...baseEscalation, situationSummary: 'Different emergency' };
      const result = await escalateEmergency(changed, 'req-12');
      expect(result.ok).toBe(false);
      expect(result.code).toBe('CONFLICT');
    });

    it('preserves the escalation when owner notification fails', async () => {
      const result = await escalateEmergency(baseEscalation, 'req-13', failingNotifier);
      expect(result.ok).toBe(false);
      expect(result.code).toBe('UPSTREAM_ERROR');
      const escalation = (result.data as any)?.escalation;
      const notification = (result.data as any)?.notification;
      expect(escalation).toBeDefined();
      expect(notification.ok).toBe(false);
      expect(store.getEscalation(escalation.id)).toBeDefined();
    });

    it('returns the original failed notification result on an identical retry without duplicating or re-notifying', async () => {
      let calls = 0;
      const countingFailingNotifier: typeof failingNotifier = async () => {
        calls += 1;
        return { ok: false, error: 'SMS gateway unavailable' };
      };
      const result1 = await escalateEmergency(baseEscalation, 'req-13a', countingFailingNotifier);
      const result2 = await escalateEmergency(baseEscalation, 'req-13b', countingFailingNotifier);
      expect(result1.ok).toBe(false);
      expect(result2.ok).toBe(false);
      expect((result1.data as any).escalation.id).toBe((result2.data as any).escalation.id);
      expect((result2.data as any).notification.ok).toBe(false);
      expect(calls).toBe(1);
    });

    it('validates required fields', async () => {
      const invalid = { ...baseEscalation, callbackNumber: '' };
      const result = await escalateEmergency(invalid, 'req-14');
      expect(result.ok).toBe(false);
      expect(result.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('retryOwnerNotification', () => {
    it('retries a failed appointment notification without creating a second record', async () => {
      const created = await scheduleAppointment(
        { ...baseAppointment, confirmed: true },
        'req-retry-appt',
        failingNotifier,
      );
      const id = (created.data as any).appointment.id;

      const retry = await retryOwnerNotification(id, 'req-retry-1');
      expect(retry.ok).toBe(true);
      expect((retry.data as any).record.id).toBe(id);
      expect(store.getAppointment(id)?.id).toBe(id);
    });

    it('retries a failed escalation notification without creating a second record', async () => {
      const created = await escalateEmergency(baseEscalation, 'req-retry-esc', failingNotifier);
      const id = (created.data as any).escalation.id;

      const retry = await retryOwnerNotification(id, 'req-retry-2');
      expect(retry.ok).toBe(true);
      expect((retry.data as any).record.id).toBe(id);
      expect(store.getEscalation(id)?.id).toBe(id);
    });

    it('returns NOT_FOUND for an unknown record', async () => {
      const result = await retryOwnerNotification('does-not-exist', 'req-retry-3');
      expect(result.ok).toBe(false);
      expect(result.code).toBe('NOT_FOUND');
    });
  });
});
