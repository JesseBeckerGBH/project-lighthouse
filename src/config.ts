import type { Result } from './errors';

export interface Config {
  nodeEnv: string;
  port: number;
  publicBaseUrl: string;
  openaiApiKey: string;
  openaiRealtimeModel: string;
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioPhoneNumber: string;
  ownerPhoneNumber: string;
  businessName: string;
  businessTimezone: string;
  businessHours: string;
  businessServiceArea: string;
  businessServices: string;
  schedulerMode: string;
  notificationMode: string;
  logLevel: string;
}

const conditionalRequired: Record<string, (env: NodeJS.ProcessEnv) => boolean | undefined> = {
  OWNER_PHONE_NUMBER: (env) => (env.NOTIFICATION_MODE ?? 'console') === 'twilio',
};

function collectMissing(env: NodeJS.ProcessEnv): string[] {
  const required = [
    'PORT',
    'PUBLIC_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_REALTIME_MODEL',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_PHONE_NUMBER',
    'BUSINESS_NAME',
    'BUSINESS_TIMEZONE',
    'BUSINESS_HOURS',
    'BUSINESS_SERVICE_AREA',
    'BUSINESS_SERVICES',
    'SCHEDULER_MODE',
    'NOTIFICATION_MODE',
    'LOG_LEVEL',
  ];

  const missing: string[] = [];
  for (const name of required) {
    if (!env[name] || (typeof env[name] === 'string' && env[name]!.trim() === '')) {
      missing.push(name);
    }
  }

  for (const [name, test] of Object.entries(conditionalRequired)) {
    if (test(env) && (!env[name] || env[name]!.trim() === '')) {
      missing.push(name);
    }
  }

  return missing;
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = collectMissing(env);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const rawPort = env.PORT ?? '3000';
  const parsedPort = parseInt(rawPort, 10);
  if (Number.isNaN(parsedPort)) {
    throw new Error('PORT must be a valid number');
  }

  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    port: parsedPort,
    publicBaseUrl: env.PUBLIC_BASE_URL!,
    openaiApiKey: env.OPENAI_API_KEY!,
    openaiRealtimeModel: env.OPENAI_REALTIME_MODEL!,
    twilioAccountSid: env.TWILIO_ACCOUNT_SID!,
    twilioAuthToken: env.TWILIO_AUTH_TOKEN!,
    twilioPhoneNumber: env.TWILIO_PHONE_NUMBER!,
    ownerPhoneNumber: env.OWNER_PHONE_NUMBER ?? '',
    businessName: env.BUSINESS_NAME!,
    businessTimezone: env.BUSINESS_TIMEZONE!,
    businessHours: env.BUSINESS_HOURS!,
    businessServiceArea: env.BUSINESS_SERVICE_AREA!,
    businessServices: env.BUSINESS_SERVICES!,
    schedulerMode: env.SCHEDULER_MODE!,
    notificationMode: env.NOTIFICATION_MODE!,
    logLevel: env.LOG_LEVEL!,
  };
}

export type { Result };
