export type Intent = 'EMERGENCY' | 'NEW_LEAD' | 'EXISTING_CUSTOMER' | 'GENERAL_QUESTION';

export interface Classification {
  intent: Intent;
  confidence: number;
  reason: string;
}

// Only immediate-risk language belongs here (spec section 7). Terms that merely signal
// impatience ('urgent', 'help me') are not safety signals and must not trigger escalation.
const EMERGENCY_TERMS = [
  'emergency',
  'fire',
  'flood',
  'gas',
  'leak',
  'danger',
  'dangerous',
  'electrical',
  'hurt',
  'injured',
  'injury',
  'trapped',
  'smoke',
  'spark',
  'burning',
  'explosion',
  'shock',
  'unconscious',
  'bleeding',
  'broken pipe',
  'water everywhere',
  'not safe',
  'unsafe',
  '911',
];

// Questions about configured facts must be answered, not treated as leads, even when they
// contain words that also appear in NEW_LEAD_TERMS ('service area' contains 'service').
const FACT_QUESTION_PHRASES = [
  'service area',
  'what area',
  'which area',
  'areas do you',
  'do you serve',
  'your hours',
  'business hours',
  'what hours',
  'hours of operation',
  'are you open',
  'when do you open',
  'when are you open',
  'what services',
  'services do you',
  'services you offer',
  'what do you offer',
  'kind of work',
  'type of work',
  'time zone',
  'timezone',
  'business name',
];

const NEW_LEAD_TERMS = [
  'new',
  'quote',
  'pricing',
  'price',
  'appointment',
  'schedule',
  'book',
  'install',
  'repair',
  'need service',
  'service call',
  'interested',
  'looking for',
  'need a',
  'want a',
];

const EXISTING_CUSTOMER_TERMS = [
  'existing',
  'customer',
  'my appointment',
  'my booking',
  'status',
  'follow up',
  'followup',
  'already',
  'scheduled',
  'when is my',
  'reschedule',
  'cancel my',
];

function hasTerms(text: string, terms: string[]): boolean {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

export function classify(summary: string): Classification {
  // Safety-related uncertainty is treated as EMERGENCY for escalation.
  if (hasTerms(summary, EMERGENCY_TERMS)) {
    return {
      intent: 'EMERGENCY',
      confidence: 0.95,
      reason: 'Safety-related keywords detected; treated as emergency',
    };
  }

  if (hasTerms(summary, EXISTING_CUSTOMER_TERMS)) {
    return {
      intent: 'EXISTING_CUSTOMER',
      confidence: 0.8,
      reason: 'References existing appointment or customer record',
    };
  }

  if (hasTerms(summary, FACT_QUESTION_PHRASES)) {
    return {
      intent: 'GENERAL_QUESTION',
      confidence: 0.9,
      reason: 'Question matches a configured business fact',
    };
  }

  if (hasTerms(summary, NEW_LEAD_TERMS)) {
    return {
      intent: 'NEW_LEAD',
      confidence: 0.85,
      reason: 'Prospective service or appointment request',
    };
  }

  return {
    intent: 'GENERAL_QUESTION',
    confidence: 0.7,
    reason: 'No strong intent signals; treated as general inquiry',
  };
}
