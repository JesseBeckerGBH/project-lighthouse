import { Router } from 'express';
import { getConfig } from '../config';
import { err } from '../errors';
import { buildTwilioUrl, validateTwilioSignature } from '../twilio/signature';

export const twilioVoiceRouter = Router();

twilioVoiceRouter.post('/', (req, res) => {
  const config = getConfig();
  const url = buildTwilioUrl(config.publicBaseUrl, '/twilio/voice');
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

  const wsBase = config.publicBaseUrl.replace(/^http/, 'ws');
  const wsUrl = `${wsBase}/twilio/media`;
  // The Media Streams `start` event does not include the caller number, so pass it
  // explicitly as a custom parameter.
  const from = (req.body?.From as string) ?? '';

  res.type('text/xml');
  res.send(
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Response><Connect><Stream url="${escapeXml(wsUrl)}">` +
      `<Parameter name="from" value="${escapeXml(from)}"/>` +
      `</Stream></Connect></Response>`,
  );
});

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
