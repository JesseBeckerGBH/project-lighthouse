import { describe, it, expect } from 'vitest';
import { classify, isIntent } from '../src/domain/classifier';

// Regression tests from the first live production call (2026-08-16, CA8a33335c...).
// The classifier keyword-matches the model's prose summary, so any summary that
// merely *mentions* a safety word is escalated -- including summaries that
// explicitly deny an emergency.
describe('classifier: negation and latching (live call regression)', () => {
  // Verbatim sanitizedSummary from the 14:04:29 audit event.
  const firstTurn =
    'Caller wants to speak and keep the assistant on the line for a moment; ' +
    'no service request or emergency stated yet.';

  // Verbatim sanitizedSummary from the 14:05:07 audit event.
  const secondTurn =
    'Caller initially asked to keep assistant on the line; earlier emergency ' +
    'classification occurred. Caller now states it is not an emergency and ' +
    'provided phone digits. No specific service request yet.';

  it('does not escalate when the summary says no emergency was stated', () => {
    expect(classify(firstTurn).intent).not.toBe('EMERGENCY');
  });

  it('does not escalate when the caller explicitly denies an emergency', () => {
    expect(classify(secondTurn).intent).not.toBe('EMERGENCY');
  });

  it('does not escalate merely because a prior classification is narrated', () => {
    const narrated = 'Earlier emergency classification occurred. Caller is asking about pricing.';
    expect(classify(narrated).intent).not.toBe('EMERGENCY');
  });
});

describe('classifier: substring false positives', () => {
  it('does not treat an offered service ("leak detection") as an emergency', () => {
    // BUSINESS_SERVICES advertises "leak detection" -- asking about it is an FAQ.
    expect(classify('Caller asks whether you offer leak detection.').intent).not.toBe('EMERGENCY');
  });

  it('does not match safety terms inside unrelated words (Las Vegas contains "gas")', () => {
    expect(classify('Caller is calling from Las Vegas about a quote.').intent).not.toBe('EMERGENCY');
  });

  it('still escalates a real emergency', () => {
    expect(classify('There is a gas leak and water everywhere').intent).toBe('EMERGENCY');
  });

  it('still escalates an active emergency described without the word emergency', () => {
    expect(classify('Water is flooding the basement and I smell smoke').intent).toBe('EMERGENCY');
  });
});

describe('classifier: model-reported intent', () => {
  it('lets the assistant downgrade a call it previously escalated', () => {
    const summary = 'Caller says it is not an emergency and wants a price for a water heater.';
    expect(classify(summary, 'NEW_LEAD').intent).toBe('NEW_LEAD');
  });

  it('accepts an escalation the keyword scan would have missed', () => {
    // No safety keyword present, but the assistant heard the risk in context.
    expect(classify('Caller describes a hazardous situation at the property.', 'EMERGENCY').intent).toBe(
      'EMERGENCY',
    );
  });

  it('overrides the assistant upward when an active safety signal is present', () => {
    // Keywords may escalate but never downgrade: a real gas leak wins.
    const summary = 'Caller mentions a gas leak in the kitchen.';
    expect(classify(summary, 'GENERAL_QUESTION').intent).toBe('EMERGENCY');
  });

  it('falls back to summary heuristics when no intent is reported', () => {
    expect(classify('I need a quote for a new install').intent).toBe('NEW_LEAD');
  });

  it('rejects an intent value the model invented', () => {
    expect(isIntent('URGENT')).toBe(false);
    expect(isIntent(undefined)).toBe(false);
    expect(isIntent('EMERGENCY')).toBe(true);
  });
});
