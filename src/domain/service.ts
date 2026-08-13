import crypto from 'crypto';
import { Result, ok, err, generateRequestId } from '../errors';
import { classify, Classification } from './classifier';
import { answerBusinessQuestion } from './faq';
import { validateSlot, createFakeAppointment, FakeAppointment } from './fakeScheduler';
import { validateEscalationInput, createEscalationRecord, EscalationRecord } from './escalation';
import {
  deriveStableIdempotencyKey,
  canonicalPayloadHash,
  saveAppointmentWithIdempotency,
  saveEscalationWithIdempotency,
} from './idempotency';
import { defaultNotifier, Notifier, NotificationContent, NotificationResult } from '../notifications/notifier';
import { store, Appointment, Escalation } from '../storage/store';
import { emit, sanitizeForAudit } from '../audit';

export { generateRequestId };

export interface AppointmentInput {
  channel: 'voice' | 'sms';
  sessionId: string;
  toolCallId: string;
  callerName: string;
  callbackNumber: string;
  serviceSummary: string;
  requestedSlot: { date: string; timeWindow: string };
  confirmed: boolean;
}

export interface EscalationInputFull {
  channel: 'voice' | 'sms';
  sessionId: string;
  toolCallId: string;
  callbackNumber: string;
  situationSummary: string;
  location?: string;
  confirmed: boolean;
}

export async function classifyCall(
  requestId: string,
  sessionId: string,
  channel: 'voice' | 'sms',
  summary: string,
): Promise<Result<Classification>> {
  const classification = classify(summary);
  emit({
    event: 'classify',
    requestId,
    channel,
    sessionId,
    classification: classification.intent,
    sanitizedSummary: sanitizeForAudit(summary, 200),
    outcome: 'success',
  });
  return ok(classification, requestId);
}

export function answerBusinessFact(
  requestId: string,
  sessionId: string,
  channel: 'voice' | 'sms',
  question: string,
): Result<string> {
  const answer = answerBusinessQuestion(question);
  emit({
    event: 'answer',
    requestId,
    channel,
    sessionId,
    outcome: answer.ok ? 'success' : 'not_configured',
  });
  return answer.ok ? ok(answer.data as string, requestId) : { ...answer, requestId };
}

export interface AppointmentResult {
  appointment: FakeAppointment;
  notification: NotificationResult;
}

export async function scheduleAppointment(
  input: AppointmentInput,
  requestId: string,
  notify: Notifier = defaultNotifier,
): Promise<Result<AppointmentResult>> {
  emit({
    event: 'schedule_attempt',
    requestId,
    channel: input.channel,
    sessionId: input.sessionId,
    action: 'validate',
  });

  if (!input.callerName || input.callerName.trim() === '') {
    return err(
      'VALIDATION_ERROR',
      'I need a name to create the appointment.',
      [{ field: 'callerName', code: 'REQUIRED' }],
      requestId,
    );
  }
  if (!input.callbackNumber || input.callbackNumber.trim() === '') {
    return err(
      'VALIDATION_ERROR',
      'I need a callback number to create the appointment.',
      [{ field: 'callbackNumber', code: 'REQUIRED' }],
      requestId,
    );
  }
  if (!input.serviceSummary || input.serviceSummary.trim() === '') {
    return err(
      'VALIDATION_ERROR',
      'I need a service summary to create the appointment.',
      [{ field: 'serviceSummary', code: 'REQUIRED' }],
      requestId,
    );
  }

  const slotValidation = validateSlot(input.requestedSlot);
  if (!slotValidation.ok) {
    return { ...slotValidation, requestId } as Result<AppointmentResult>;
  }

  if (!input.confirmed) {
    emit({
      event: 'schedule_attempt',
      requestId,
      channel: input.channel,
      sessionId: input.sessionId,
      action: 'awaiting_confirmation',
      outcome: 'confirmation_required',
    });
    return err(
      'CONFIRMATION_REQUIRED',
      'Please confirm after I read back the details. This is a demo request and not a guaranteed real booking.',
      [{ field: 'confirmed', code: 'REQUIRED' }],
      requestId,
    );
  }

  const idempotencyKey = deriveStableIdempotencyKey(input.channel, input.sessionId, input.toolCallId);
  const payload = {
    callerName: input.callerName,
    callbackNumber: input.callbackNumber,
    serviceSummary: input.serviceSummary,
    requestedSlot: input.requestedSlot,
    confirmed: input.confirmed,
  };
  const payloadHash = canonicalPayloadHash(payload);

  const existing = store.getByIdempotency(idempotencyKey);
  if (existing) {
    if (existing.payloadHash === payloadHash) {
      const appointment = existing.record as FakeAppointment;
      const originalResult: AppointmentResult = {
        appointment,
        notification: existing.notificationResult,
      };
      return existing.notificationResult.ok
        ? ok(originalResult, requestId)
        : err(
            'UPSTREAM_ERROR',
            'The demo appointment was saved, but the owner notification failed. Please retry the notification.',
            [{ field: 'notification', code: 'RETRYABLE' }],
            requestId,
            originalResult,
          );
    }
    return err(
      'CONFLICT',
      'This appointment request was already processed with different details.',
      [{ field: 'idempotencyKey', code: 'CONFLICT' }],
      requestId,
    );
  }

  const safeSummary = sanitizeForAudit(input.serviceSummary, 200);
  const appointment = createFakeAppointment(
    input.callerName,
    input.callbackNumber,
    safeSummary,
    input.requestedSlot,
  );

  const notification = await notify({
    channel: input.channel,
    caller: input.callbackNumber,
    classification: 'NEW_LEAD',
    summary: `Demo appointment for ${safeSummary} on ${input.requestedSlot.date} ${input.requestedSlot.timeWindow}`,
    recordId: appointment.id,
    nextAction: 'review demo appointment',
    timestamp: new Date().toISOString(),
    requestId,
  });

  const result: AppointmentResult = { appointment, notification };
  saveAppointmentWithIdempotency(idempotencyKey, payloadHash, appointment, notification, input.channel, 'NEW_LEAD');

  emit({
    event: 'schedule_confirmed',
    requestId,
    channel: input.channel,
    sessionId: input.sessionId,
    recordId: appointment.id,
    action: 'create',
    outcome: notification.ok ? 'success' : 'failure',
  });

  if (!notification.ok) {
    return err(
      'UPSTREAM_ERROR',
      'The demo appointment was saved, but the owner notification failed. Please retry the notification.',
      [{ field: 'notification', code: 'RETRYABLE' }],
      requestId,
      result,
    );
  }

  return ok(result, requestId);
}

export interface EscalationResult {
  escalation: EscalationRecord;
  notification: NotificationResult;
}

export async function escalateEmergency(
  input: EscalationInputFull,
  requestId: string,
  notify: Notifier = defaultNotifier,
): Promise<Result<EscalationResult>> {
  const validation = validateEscalationInput({
    callbackNumber: input.callbackNumber,
    situationSummary: input.situationSummary,
    location: input.location,
    confirmed: input.confirmed,
  });

  if (!validation.ok) {
    return { ...validation, requestId } as Result<EscalationResult>;
  }

  const idempotencyKey = deriveStableIdempotencyKey(input.channel, input.sessionId, input.toolCallId);
  const payload = {
    callbackNumber: input.callbackNumber,
    situationSummary: input.situationSummary,
    location: input.location,
    confirmed: input.confirmed,
  };
  const payloadHash = canonicalPayloadHash(payload);

  const existing = store.getByIdempotency(idempotencyKey);
  if (existing) {
    if (existing.payloadHash === payloadHash) {
      const escalation = existing.record as EscalationRecord;
      const originalResult: EscalationResult = {
        escalation,
        notification: existing.notificationResult,
      };
      return existing.notificationResult.ok
        ? ok(originalResult, requestId)
        : err(
            'UPSTREAM_ERROR',
            'The emergency was recorded, but the owner notification failed. Please retry the notification.',
            [{ field: 'notification', code: 'RETRYABLE' }],
            requestId,
            originalResult,
          );
    }
    return err(
      'CONFLICT',
      'This emergency request was already received with different details.',
      [{ field: 'idempotencyKey', code: 'CONFLICT' }],
      requestId,
    );
  }

  // Emergency record creation is not blocked by the `confirmed` flag.
  const safeSummary = sanitizeForAudit(input.situationSummary, 200);
  const escalation = createEscalationRecord({
    callbackNumber: input.callbackNumber,
    situationSummary: safeSummary,
    location: input.location,
    confirmed: input.confirmed,
  });

  const notification = await notify({
    channel: input.channel,
    caller: input.callbackNumber,
    classification: 'EMERGENCY',
    summary: safeSummary,
    recordId: escalation.id,
    nextAction: 'urgent human follow-up',
    timestamp: new Date().toISOString(),
    requestId,
  });

  const result: EscalationResult = { escalation, notification };
  saveEscalationWithIdempotency(idempotencyKey, payloadHash, escalation, notification, input.channel, 'EMERGENCY');

  emit({
    event: 'escalate',
    requestId,
    channel: input.channel,
    sessionId: input.sessionId,
    recordId: escalation.id,
    action: 'create',
    outcome: notification.ok ? 'success' : 'failure',
  });

  if (!notification.ok) {
    return err(
      'UPSTREAM_ERROR',
      'The emergency was recorded, but the owner notification failed. Please retry the notification.',
      [{ field: 'notification', code: 'RETRYABLE' }],
      requestId,
      result,
    );
  }

  return ok(result, requestId);
}

type RetryResult = { record: Appointment | Escalation; notification: NotificationResult };

export async function retryOwnerNotification(
  recordId: string,
  requestId: string,
  notify: Notifier = defaultNotifier,
): Promise<Result<RetryResult>> {
  const stored = store.getByRecordId(recordId);
  if (!stored) {
    return err('NOT_FOUND', 'No record found to retry notification.', [{ field: 'recordId', code: 'NOT_FOUND' }], requestId);
  }

  const summary =
    'serviceSummary' in stored.record
      ? `Demo appointment for ${stored.record.serviceSummary} on ${stored.record.requestedSlot.date} ${stored.record.requestedSlot.timeWindow}`
      : stored.record.situationSummary;

  const notification = await notify({
    channel: stored.channel,
    caller: stored.record.callbackNumber,
    classification: stored.classification,
    summary,
    recordId: stored.record.id,
    nextAction: stored.classification === 'EMERGENCY' ? 'urgent human follow-up' : 'review demo appointment',
    timestamp: new Date().toISOString(),
    requestId,
  });

  store.updateNotificationResult(stored.idempotencyKey, notification);

  emit({
    event: 'notify',
    requestId,
    channel: stored.channel,
    sessionId: recordId,
    recordId,
    action: 'retry',
    outcome: notification.ok ? 'success' : 'failure',
  });

  const result: RetryResult = { record: stored.record, notification };

  if (!notification.ok) {
    return err(
      'UPSTREAM_ERROR',
      'The notification retry failed. The record is unchanged.',
      [{ field: 'notification', code: 'RETRYABLE' }],
      requestId,
      result,
    );
  }

  return ok(result, requestId);
}
