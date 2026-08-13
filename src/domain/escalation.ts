import crypto from 'crypto';
import { Result, ok, err } from '../errors';

export interface EscalationRecord {
  id: string;
  callbackNumber: string;
  situationSummary: string;
  location?: string;
  confirmed: boolean;
  createdAt: string;
}

export interface EscalationInput {
  callbackNumber: string;
  situationSummary: string;
  location?: string;
  confirmed: boolean;
}

export function validateEscalationInput(input: EscalationInput): Result<null> {
  if (!input.callbackNumber || input.callbackNumber.trim() === '') {
    return err('VALIDATION_ERROR', 'A callback number is required.', [
      { field: 'callbackNumber', code: 'REQUIRED' },
    ]);
  }
  if (!input.situationSummary || input.situationSummary.trim() === '') {
    return err('VALIDATION_ERROR', 'A situation summary is required.', [
      { field: 'situationSummary', code: 'REQUIRED' },
    ]);
  }
  return ok(null);
}

export function createEscalationRecord(input: EscalationInput): EscalationRecord {
  return {
    id: `esc-${crypto.randomBytes(8).toString('hex')}`,
    callbackNumber: input.callbackNumber,
    situationSummary: input.situationSummary,
    location: input.location,
    confirmed: input.confirmed,
    createdAt: new Date().toISOString(),
  };
}
