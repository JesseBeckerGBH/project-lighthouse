import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { emit, sanitizeForAudit } from '../src/audit';

describe('audit sanitization', () => {
  it('redacts phone numbers', () => {
    const result = sanitizeForAudit('Call me at 602-555-1234 or (480) 555-9876', 200);
    expect(result).not.toContain('602-555-1234');
    expect(result).not.toContain('(480) 555-9876');
    expect(result).toContain('[REDACTED-PHONE]');
  });

  it('redacts payment-like numbers', () => {
    const result = sanitizeForAudit('My card is 4111 1111 1111 1111', 200);
    expect(result).not.toContain('4111 1111 1111 1111');
    expect(result).toContain('[REDACTED-PAYMENT]');
  });

  it('redacts credential patterns', () => {
    const result = sanitizeForAudit('api_key=sk-12345 and Bearer abcdef', 200);
    expect(result).not.toContain('sk-12345');
    expect(result).not.toContain('Bearer abcdef');
    expect(result).toContain('[REDACTED-CREDENTIAL]');
  });

  it('redacts email addresses', () => {
    const result = sanitizeForAudit('Contact me at user@example.com', 200);
    expect(result).not.toContain('user@example.com');
    expect(result).toContain('[REDACTED-EMAIL]');
  });

  it('truncates long text', () => {
    const long = 'a'.repeat(300);
    const result = sanitizeForAudit(long, 100);
    expect(result.length).toBeLessThanOrEqual(104);
  });

  it('never writes raw SMS text to the audit stream', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sensitive = 'My card is 4111 1111 1111 1111, call 602-555-1234, api_key=secret';
    emit({
      event: 'sms_in',
      requestId: 'req-1',
      channel: 'sms',
      sessionId: 'SM123',
      sanitizedSummary: sensitive,
    });
    const output = log.mock.calls.map((call) => call[0]).join('\n');
    expect(output).not.toContain('4111 1111 1111 1111');
    expect(output).not.toContain('602-555-1234');
    expect(output).not.toContain('secret');
    expect(output).toContain('[REDACTED-PAYMENT]');
    expect(output).toContain('[REDACTED-PHONE]');
    log.mockRestore();
  });
});
