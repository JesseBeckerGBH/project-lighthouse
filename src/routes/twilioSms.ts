import { Router } from 'express';
import { getConfig } from '../config';
import { err, ok, generateRequestId } from '../errors';
import { buildTwilioUrl, validateTwilioSignature } from '../twilio/signature';
import { classify } from '../domain/classifier';
import { answerBusinessQuestion } from '../domain/faq';
import { escalateEmergency, EscalationInputFull } from '../domain/service';
import { deriveStableIdempotencyKey } from '../domain/idempotency';
import { emit } from '../audit';

export const twilioSmsRouter = Router();

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

twilioSmsRouter.post('/', async (req, res) => {
  const config = getConfig();
  const url = buildTwilioUrl(config.publicBaseUrl, '/twilio/sms');
  const signature = (req.headers['x-twilio-signature'] as string) ?? '';

  if (config.twilioAuthToken) {
    if (!signature) {
      res.status(403).json(err('VALIDATION_ERROR', 'Missing Twilio signature.'));
      return;
    }
    if (!validateTwilioSignature(config.twilioAuthToken, url, req.body, signature)) {
      res.status(403).json(err('VALIDATION_ERROR', 'Invalid Twilio signature.'));
      return;
    }
  }

  const from = (req.body.From as string) ?? 'unknown';
  const body = (req.body.Body as string)?.trim() ?? '';
  const messageSid = (req.body.MessageSid as string) ?? `sms-${generateRequestId()}`;
  const requestId = generateRequestId();
  const sessionId = messageSid;

  const classification = classify(body);

  emit({
    event: 'sms_in',
    requestId,
    channel: 'sms',
    sessionId,
    classification: classification.intent,
    sanitizedSummary: `Inbound SMS classified as ${classification.intent}`,
  });

  let reply = '';

  try {
    switch (classification.intent) {
      case 'EMERGENCY': {
        const toolCallId = 'escalate';
        const input: EscalationInputFull = {
          channel: 'sms',
          sessionId,
          toolCallId,
          callbackNumber: from,
          situationSummary: body,
          confirmed: true,
        };
        const result = await escalateEmergency(input, requestId);
        if (result.code === 'CONFLICT') {
          reply = 'This emergency message was already received. Please call 911 if you are in immediate danger.';
        } else if (!result.ok && result.data && 'escalation' in result.data) {
          reply = 'I recorded your emergency. I could not notify the owner; please also call 911 if you are in immediate danger.';
        } else if (result.ok) {
          reply = 'I recorded your emergency. Please also call 911 if you are in immediate danger.';
        } else {
          reply = 'I could not process the emergency message. Please call 911.';
        }
        break;
      }
      case 'GENERAL_QUESTION': {
        const answer = answerBusinessQuestion(body);
        if (!answer.ok) {
          reply = answer.message;
        } else {
          reply = answer.data as string;
        }
        break;
      }
      case 'NEW_LEAD':
        reply = 'Thanks for your interest. Please text your name, service, and preferred date/time window. This is a demo; scheduling is simulated.';
        break;
      case 'EXISTING_CUSTOMER':
        reply = 'I can look that up for you. This is a demo; a human will follow up.';
        break;
      default:
        reply = 'Thanks for contacting us. How can I help you today?';
    }
  } catch {
    reply = 'Sorry, I could not process your message. Please try again.';
  }

  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`);
});
