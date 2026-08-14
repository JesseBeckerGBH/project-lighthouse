import { store } from '../src/storage/store';

process.env.NODE_ENV = 'test';
process.env.PORT = '3000';
process.env.PUBLIC_BASE_URL = 'http://localhost';
process.env.OPENAI_API_KEY = 'fake-openai-key';
process.env.OPENAI_REALTIME_MODEL = 'fake-realtime-model';
process.env.TWILIO_ACCOUNT_SID = 'fake-account-sid';
process.env.TWILIO_AUTH_TOKEN = 'fake-auth-token';
process.env.TWILIO_PHONE_NUMBER = '+15551234567';
process.env.OWNER_PHONE_NUMBER = '+15559876543';
process.env.BUSINESS_NAME = 'JB Receptionist Demo';
process.env.BUSINESS_TIMEZONE = 'America/Phoenix';
process.env.BUSINESS_HOURS = 'Monday-Friday 8:00 AM-5:00 PM';
process.env.BUSINESS_SERVICE_AREA = 'Chandler, Arizona';
process.env.BUSINESS_SERVICES = 'Water heater repair, drain cleaning, leak detection';
process.env.SCHEDULER_MODE = 'fake';
process.env.NOTIFICATION_MODE = 'console';
process.env.LOG_LEVEL = 'silent';

beforeEach(() => {
  store.reset();
});
