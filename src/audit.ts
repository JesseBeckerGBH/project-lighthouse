const PHONE_PATTERN = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
const PAYMENT_PATTERN = /\b(?:\d[ -]*){13,19}\b/g;
const CREDENTIAL_PATTERN = /\b(?:api[_-]?key|token|password|secret|bearer|authorization|auth)\s*[:=]?\s*\S+/gi;
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;

export type AuditEventType =
  | 'classify'
  | 'answer'
  | 'schedule_attempt'
  | 'schedule_confirmed'
  | 'escalate'
  | 'notify'
  | 'media'
  | 'call_end'
  | 'sms_in'
  | 'voice_in'
  | 'error'
  // OpenAI Realtime turn-lifecycle event types (no content). Distinguishes a
  // silent stall from a missed turn; see LIFECYCLE_EVENTS in realtime/bridge.ts.
  | 'diagnostic';

export interface AuditEvent {
  event: AuditEventType;
  requestId: string;
  channel: 'voice' | 'sms';
  sessionId: string;
  classification?: string;
  sanitizedSummary?: string;
  recordId?: string;
  action?: string;
  outcome?: 'success' | 'failure' | 'conflict' | 'not_configured' | 'confirmation_required';
  details?: Record<string, unknown>;
}

export function sanitizeForAudit(text: string, maxLength = 200): string {
  if (!text || text.trim() === '') return '';
  let safe = text;
  safe = safe.replace(PHONE_PATTERN, '[REDACTED-PHONE]');
  safe = safe.replace(PAYMENT_PATTERN, '[REDACTED-PAYMENT]');
  safe = safe.replace(CREDENTIAL_PATTERN, '[REDACTED-CREDENTIAL]');
  safe = safe.replace(EMAIL_PATTERN, '[REDACTED-EMAIL]');
  if (safe.length > maxLength) {
    safe = safe.slice(0, maxLength) + '...';
  }
  return safe;
}

export function emit(event: AuditEvent): void {
  // Structured event logging. Secrets and full transcript content are never included.
  const safeEvent: Record<string, unknown> = {
    event: event.event,
    requestId: event.requestId,
    channel: event.channel,
    sessionId: event.sessionId,
  };
  if (event.classification) safeEvent.classification = event.classification;
  if (event.sanitizedSummary) safeEvent.sanitizedSummary = sanitizeForAudit(event.sanitizedSummary);
  if (event.recordId) safeEvent.recordId = event.recordId;
  if (event.action) safeEvent.action = event.action;
  if (event.outcome) safeEvent.outcome = event.outcome;
  if (event.details) safeEvent.details = redactDetails(event.details);
  safeEvent.timestamp = new Date().toISOString();
  console.log(`[AUDIT] ${JSON.stringify(safeEvent)}`);
}

function redactDetails(details: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string') {
      redacted[key] = sanitizeForAudit(value);
    } else if (value && typeof value === 'object') {
      redacted[key] = sanitizeObject(value as Record<string, unknown>);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

function sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = sanitizeForAudit(value);
    } else if (value && typeof value === 'object') {
      result[key] = sanitizeObject(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}
