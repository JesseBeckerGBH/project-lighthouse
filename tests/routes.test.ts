import request from 'supertest';
import { getExpectedTwilioSignature } from 'twilio';
import { describe, it, expect, vi } from 'vitest';
import { app } from '../src/server';
import { getConfig } from '../src/config';
import { store } from '../src/storage/store';
import { deriveStableIdempotencyKey } from '../src/domain/idempotency';

const fakeSmsBody = { MessageSid: 'SM123', From: '+15551234567', Body: 'There is a fire', To: '+15559876543' };
const fakeVoiceBody = { CallSid: 'CA123', From: '+15551234567', To: '+15559876543', AccountSid: 'AC123' };

describe('HTTP routes', () => {
  it('GET /health returns service readiness without secrets', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('fake-openai-key');
    expect(text).not.toContain('fake-auth-token');
  });

  describe('POST /twilio/voice', () => {
    it('returns TwiML pointing to the correct WebSocket URL (http -> ws)', async () => {
      const config = getConfig();
      const url = `${config.publicBaseUrl}/twilio/voice`;
      const signature = getExpectedTwilioSignature(config.twilioAuthToken, url, fakeVoiceBody);
      const res = await request(app)
        .post('/twilio/voice')
        .set('X-Twilio-Signature', signature)
        .type('form')
        .send(fakeVoiceBody);
      expect(res.status).toBe(200);
      expect(res.text).toContain('ws://localhost/twilio/media');
      expect(res.text).not.toContain('fake-openai-key');
    });

    it('returns secure wss TwiML when public base URL is https', async () => {
      const original = process.env.PUBLIC_BASE_URL;
      process.env.PUBLIC_BASE_URL = 'https://example.com';
      const config = getConfig();
      const url = `${config.publicBaseUrl}/twilio/voice`;
      const signature = getExpectedTwilioSignature(config.twilioAuthToken, url, fakeVoiceBody);
      const res = await request(app)
        .post('/twilio/voice')
        .set('X-Twilio-Signature', signature)
        .type('form')
        .send(fakeVoiceBody);
      expect(res.text).toContain('wss://example.com/twilio/media');
      process.env.PUBLIC_BASE_URL = original;
    });

    it('rejects an invalid Twilio signature', async () => {
      const res = await request(app)
        .post('/twilio/voice')
        .set('X-Twilio-Signature', 'invalid-signature')
        .type('form')
        .send(fakeVoiceBody);
      expect(res.status).toBe(403);
      expect(res.body.ok).toBe(false);
    });
  });

  describe('POST /twilio/sms', () => {
    it('replies to a configured business question', async () => {
      const config = getConfig();
      const body = { ...fakeSmsBody, Body: 'What are your hours?' };
      const url = `${config.publicBaseUrl}/twilio/sms`;
      const signature = getExpectedTwilioSignature(config.twilioAuthToken, url, body);
      const res = await request(app)
        .post('/twilio/sms')
        .set('X-Twilio-Signature', signature)
        .type('form')
        .send(body);
      expect(res.status).toBe(200);
      expect(res.text).toContain(config.businessHours);
    });

    it('escalates an emergency and returns safe handoff language', async () => {
      const config = getConfig();
      const body = { ...fakeSmsBody, Body: 'There is a fire in the house' };
      const url = `${config.publicBaseUrl}/twilio/sms`;
      const signature = getExpectedTwilioSignature(config.twilioAuthToken, url, body);
      const res = await request(app)
        .post('/twilio/sms')
        .set('X-Twilio-Signature', signature)
        .type('form')
        .send(body);
      expect(res.status).toBe(200);
      expect(res.text).toContain('recorded your emergency');
      expect(res.text).not.toContain('dispatched');
      const key = deriveStableIdempotencyKey('sms', 'SM123', 'escalate');
      expect(store.getByIdempotency(key)).toBeDefined();
    });

    it('is idempotent for duplicate SMS delivery', async () => {
      const config = getConfig();
      const body = { ...fakeSmsBody, Body: 'There is a fire in the house' };
      const url = `${config.publicBaseUrl}/twilio/sms`;
      const signature = getExpectedTwilioSignature(config.twilioAuthToken, url, body);

      const res1 = await request(app)
        .post('/twilio/sms')
        .set('X-Twilio-Signature', signature)
        .type('form')
        .send(body);
      expect(res1.status).toBe(200);

      const res2 = await request(app)
        .post('/twilio/sms')
        .set('X-Twilio-Signature', signature)
        .type('form')
        .send(body);
      expect(res2.status).toBe(200);

      const key = deriveStableIdempotencyKey('sms', 'SM123', 'escalate');
      const record = store.getByIdempotency(key);
      expect(record).toBeDefined();
    });

    it('returns CONFLICT for same MessageSid with different body', async () => {
      const config = getConfig();
      const body1 = { ...fakeSmsBody, Body: 'There is a fire in the house' };
      const url = `${config.publicBaseUrl}/twilio/sms`;
      const sig1 = getExpectedTwilioSignature(config.twilioAuthToken, url, body1);
      await request(app)
        .post('/twilio/sms')
        .set('X-Twilio-Signature', sig1)
        .type('form')
        .send(body1);

      const body2 = { ...fakeSmsBody, Body: 'The fire is spreading' };
      const sig2 = getExpectedTwilioSignature(config.twilioAuthToken, url, body2);
      const res = await request(app)
        .post('/twilio/sms')
        .set('X-Twilio-Signature', sig2)
        .type('form')
        .send(body2);
      expect(res.status).toBe(200);
      expect(res.text).toContain('already received');
    });

    it('rejects an invalid Twilio signature', async () => {
      const res = await request(app)
        .post('/twilio/sms')
        .set('X-Twilio-Signature', 'bad-sig')
        .type('form')
        .send(fakeSmsBody);
      expect(res.status).toBe(403);
      expect(res.body.ok).toBe(false);
      expect(res.body.message).toContain('Invalid Twilio signature');
    });

    it('does not write sensitive narrative text to audit logs', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const config = getConfig();
      const sensitiveBody = 'I am in a very personal situation and I cannot share details';
      const body = { ...fakeSmsBody, Body: sensitiveBody };
      const url = `${config.publicBaseUrl}/twilio/sms`;
      const signature = getExpectedTwilioSignature(config.twilioAuthToken, url, body);

      const res = await request(app)
        .post('/twilio/sms')
        .set('X-Twilio-Signature', signature)
        .type('form')
        .send(body);

      expect(res.status).toBe(200);
      const output = log.mock.calls.map((call) => call[0]).join('\n');
      expect(output).not.toContain(sensitiveBody);
      expect(output).not.toContain('personal situation');
      expect(output).toContain('Inbound SMS classified as');
      log.mockRestore();
    });
  });

  describe('POST /demo/reset', () => {
    it('clears demo records in test mode', async () => {
      await store.saveAppointment('key1', 'hash1', {
        id: 'apt-1',
        callerName: 'A',
        callbackNumber: '+1',
        serviceSummary: 'test',
        requestedSlot: { date: '2025-01-01', timeWindow: 'morning' },
        status: 'demo',
        createdAt: new Date().toISOString(),
      }, { ok: true }, 'sms', 'NEW_LEAD');
      const res = await request(app).post('/demo/reset');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(store.getAppointment('apt-1')).toBeUndefined();
    });

    it('does not exist in production mode', async () => {
      const original = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const res = await request(app).post('/demo/reset');
        expect(res.status).toBe(404);
      } finally {
        process.env.NODE_ENV = original;
      }
    });
  });
});
