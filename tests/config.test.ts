import { describe, it, expect } from 'vitest';
import { getConfig } from '../src/config';

const completeEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  PORT: '3000',
  PUBLIC_BASE_URL: 'http://localhost',
  OPENAI_API_KEY: 'fake-openai-key',
  OPENAI_REALTIME_MODEL: 'fake-realtime-model',
  TWILIO_ACCOUNT_SID: 'fake-account-sid',
  TWILIO_AUTH_TOKEN: 'fake-auth-token',
  TWILIO_PHONE_NUMBER: '+15551234567',
  OWNER_PHONE_NUMBER: '+15559876543',
  BUSINESS_NAME: 'JB Receptionist Demo',
  BUSINESS_TIMEZONE: 'America/Phoenix',
  BUSINESS_HOURS: 'Monday-Friday 8:00 AM-5:00 PM',
  BUSINESS_SERVICE_AREA: 'Chandler, Arizona',
  SCHEDULER_MODE: 'fake',
  NOTIFICATION_MODE: 'console',
  LOG_LEVEL: 'silent',
};

describe('config', () => {
  it('loads a complete environment', () => {
    const config = getConfig(completeEnv);
    expect(config.businessName).toBe('JB Receptionist Demo');
    expect(config.port).toBe(3000);
  });

  it('throws for missing required variables without printing values', () => {
    const partial = { ...completeEnv, OPENAI_API_KEY: undefined } as unknown as NodeJS.ProcessEnv;
    expect(() => getConfig(partial)).toThrow('Missing required environment variables');
    try {
      getConfig(partial);
    } catch (e: any) {
      expect(e.message).not.toContain('fake-openai-key');
      expect(e.message).toContain('OPENAI_API_KEY');
    }
  });

  it('lists multiple missing variables', () => {
    const partial = { ...completeEnv, OPENAI_API_KEY: undefined, TWILIO_AUTH_TOKEN: undefined } as unknown as NodeJS.ProcessEnv;
    expect(() => getConfig(partial)).toThrow(/OPENAI_API_KEY/);
    expect(() => getConfig(partial)).toThrow(/TWILIO_AUTH_TOKEN/);
  });

  it('requires OWNER_PHONE_NUMBER when NOTIFICATION_MODE is twilio', () => {
    const twilioMode = { ...completeEnv, NOTIFICATION_MODE: 'twilio', OWNER_PHONE_NUMBER: '' };
    expect(() => getConfig(twilioMode)).toThrow('OWNER_PHONE_NUMBER');
  });

  it('rejects an invalid PORT', () => {
    const invalid = { ...completeEnv, PORT: 'not-a-number' };
    expect(() => getConfig(invalid)).toThrow('PORT must be a valid number');
  });
});
