import request from 'supertest';
import { getExpectedTwilioSignature } from 'twilio';
import { describe, it, expect } from 'vitest';
import { app } from '../src/server';
import { getConfig } from '../src/config';

const SECRET_SUBSTRINGS = [
  'fake-openai-key',
  'fake-auth-token',
  'fake-account-sid',
];

const fakeVoiceBody = { CallSid: 'CA123', From: '+15551234567', To: '+15559876543', AccountSid: 'AC123' };
const fakeSmsBody = { MessageSid: 'SM123', From: '+15551234567', Body: 'What are your hours?', To: '+15559876543' };

describe('secret leak checks', () => {
  it('GET /health response does not contain secrets', async () => {
    const res = await request(app).get('/health');
    const text = JSON.stringify(res.body) + res.text;
    for (const secret of SECRET_SUBSTRINGS) {
      expect(text).not.toContain(secret);
    }
  });

  it('POST /twilio/voice TwiML does not contain secrets', async () => {
    const config = getConfig();
    const url = `${config.publicBaseUrl}/twilio/voice`;
    const signature = getExpectedTwilioSignature(config.twilioAuthToken, url, fakeVoiceBody);

    const res = await request(app)
      .post('/twilio/voice')
      .set('X-Twilio-Signature', signature)
      .type('form')
      .send(fakeVoiceBody);
    const text = JSON.stringify(res.body) + res.text;
    for (const secret of SECRET_SUBSTRINGS) {
      expect(text).not.toContain(secret);
    }
  });

  it('POST /twilio/sms TwiML does not contain secrets', async () => {
    const config = getConfig();
    const url = `${config.publicBaseUrl}/twilio/sms`;
    const signature = getExpectedTwilioSignature(config.twilioAuthToken, url, fakeSmsBody);

    const res = await request(app)
      .post('/twilio/sms')
      .set('X-Twilio-Signature', signature)
      .type('form')
      .send(fakeSmsBody);
    const text = JSON.stringify(res.body) + res.text;
    for (const secret of SECRET_SUBSTRINGS) {
      expect(text).not.toContain(secret);
    }
  });
});
