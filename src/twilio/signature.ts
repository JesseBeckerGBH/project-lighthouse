import { validateRequest, getExpectedTwilioSignature } from 'twilio';

export function buildTwilioUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}${path}`;
}

export function validateTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, unknown>,
  signature: string,
): boolean {
  return validateRequest(authToken, signature, url, params);
}

export function signTwilioRequest(
  authToken: string,
  url: string,
  params: Record<string, unknown>,
): string {
  return getExpectedTwilioSignature(authToken, url, params);
}
