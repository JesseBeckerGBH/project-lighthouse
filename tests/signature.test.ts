import { describe, it, expect } from 'vitest';
import { validateRequest, getExpectedTwilioSignature } from 'twilio';
import { validateTwilioSignature, signTwilioRequest, buildTwilioUrl } from '../src/twilio/signature';

const authToken = 'test-auth-token';
const url = buildTwilioUrl('https://example.com', '/twilio/sms');
const params = { MessageSid: 'SM123', From: '+15551234567', Body: 'Hello' };

describe('Twilio signature validation', () => {
  it('validates a request using the official Twilio helper', () => {
    const signature = getExpectedTwilioSignature(authToken, url, params);
    expect(validateRequest(authToken, signature, url, params)).toBe(true);
  });

  it('rejects a request with an invalid signature using the official helper', () => {
    expect(validateRequest(authToken, 'not-a-signature', url, params)).toBe(false);
  });

  it('wraps the official validator for the route layer', () => {
    const signature = signTwilioRequest(authToken, url, params);
    expect(validateTwilioSignature(authToken, url, params, signature)).toBe(true);
  });

  it('rejects a tampered body with the wrapper', () => {
    const signature = signTwilioRequest(authToken, url, params);
    const tampered = { ...params, Body: 'Tampered' };
    expect(validateTwilioSignature(authToken, url, tampered, signature)).toBe(false);
  });
});
