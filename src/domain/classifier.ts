export type Intent = 'EMERGENCY' | 'NEW_LEAD' | 'EXISTING_CUSTOMER' | 'GENERAL_QUESTION';

export interface Classification {
  intent: Intent;
  confidence: number;
  reason: string;
}

const EMERGENCY_TERMS = [
  'emergency',
  'fire',
  'flood',
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
  'urgent',
  'help me',
  '911',
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
  'service',
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
