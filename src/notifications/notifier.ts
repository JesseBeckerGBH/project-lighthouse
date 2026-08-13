import twilio from 'twilio';
import { getConfig } from '../config';
import { sanitizeForAudit } from '../audit';

export type Channel = 'voice' | 'sms';

export interface NotificationContent {
  channel: Channel;
  caller: string;
  classification: string;
  summary: string;
  recordId?: string;
  nextAction: 'call back' | 'review demo appointment' | 'urgent human follow-up';
  timestamp: string;
  requestId: string;
}

export interface NotificationResult {
  ok: boolean;
  error?: string;
}

export type Notifier = (content: NotificationContent) => Promise<NotificationResult>;

export async function defaultNotifier(content: NotificationContent): Promise<NotificationResult> {
  const config = getConfig();
  const message = buildMessage(content);

  if (config.notificationMode === 'console') {
    console.log('[OWNER NOTIFICATION]', message);
    return { ok: true };
  }

  if (config.notificationMode === 'twilio') {
    try {
      const client = twilio(config.twilioAccountSid, config.twilioAuthToken);
      await client.messages.create({
        body: message,
        from: config.twilioPhoneNumber,
        to: config.ownerPhoneNumber,
      });
      return { ok: true };
    } catch {
      // Do not surface raw Twilio error messages to callers or the agent.
      return { ok: false, error: 'Owner SMS notification failed' };
    }
  }

  return { ok: false, error: `Unknown notification mode: ${config.notificationMode}` };
}

function buildMessage(content: NotificationContent): string {
  const safeSummary = sanitizeForAudit(content.summary, 200);
  const parts: (string | null)[] = [
    `Channel: ${content.channel}`,
    `Caller: ${content.caller}`,
    `Classification: ${content.classification}`,
    `Summary: ${safeSummary}`,
    content.recordId ? `Record ID: ${content.recordId}` : null,
    `Next action: ${content.nextAction}`,
    `Time: ${content.timestamp}`,
    `Request ID: ${content.requestId}`,
  ];
  return parts.filter((p): p is string => p !== null).join(' | ');
}
