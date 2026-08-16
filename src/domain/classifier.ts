export type Intent = 'EMERGENCY' | 'NEW_LEAD' | 'EXISTING_CUSTOMER' | 'GENERAL_QUESTION';

export interface Classification {
  intent: Intent;
  confidence: number;
  reason: string;
}

const INTENTS: readonly Intent[] = [
  'EMERGENCY',
  'NEW_LEAD',
  'EXISTING_CUSTOMER',
  'GENERAL_QUESTION',
];

/** Narrows untrusted model output to a declared Intent. */
export function isIntent(value: unknown): value is Intent {
  return typeof value === 'string' && (INTENTS as readonly string[]).includes(value);
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

// Cues that neutralize a safety term appearing in the same clause.
//
// The summary is prose written by the model, so a safety word can appear while
// describing the *absence* of danger ('no emergency stated yet'), or while
// narrating an earlier classification ('earlier emergency classification
// occurred'). Matching those escalates a call that nobody said was urgent, and
// the narration case latches: once one turn escalates, every later summary
// mentions it and the call can never be downgraded.
const NEGATION_CUES = [
  'no ',
  'not ',
  "n't",
  'never',
  'without',
  'denies',
  'denied',
  'declines',
  'ruled out',
  'non-',
];

// The model narrating its own prior decisions is not a fresh safety signal.
const NARRATION_CUES = [
  'earlier',
  'previously',
  'prior ',
  'classification',
  'classified',
  'already logged',
  'already recorded',
];

// Asking whether a service is offered is an FAQ, not an active emergency.
const OFFER_CUES = [
  'offer',
  'provide',
  'advertise',
  'do you do',
  'services',
  'kind of work',
  'type of work',
];

// Advertised service names that contain a safety word. A caller asking about
// 'leak detection' (a configured BUSINESS_SERVICES entry) is not reporting a leak.
const SERVICE_PHRASES = ['leak detection'];

// Terms that carry their own negation and must survive negation neutralization.
const SELF_NEGATED_TERMS = ['not safe'];

function termPattern(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Allow common inflections ('flood' -> 'flooding') without matching unrelated
  // words that merely start with the term ('gas' must not match 'gasket', and the
  // leading boundary keeps 'Las Vegas' from matching 'gas').
  return new RegExp(`\\b${escaped}(?:s|es|ed|ing)?\\b`, 'i');
}

function hasTerms(text: string, terms: string[]): boolean {
  return terms.some((term) => termPattern(term).test(text));
}

function splitClauses(text: string): string[] {
  return text
    .split(/[.;,]|\bbut\b/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

function containsCue(clause: string, cues: string[]): boolean {
  const padded = ` ${clause.toLowerCase()} `;
  return cues.some((cue) => padded.includes(cue));
}

/**
 * True only when a clause reports an active safety risk.
 *
 * This is a backstop, not the primary signal: the model reports its own intent
 * and can escalate on its own. Because of that, this deliberately errs toward
 * staying quiet when a clause is negated -- a false emergency pages the owner
 * and trains them to ignore the alert, which is worse than relying on the
 * model's judgment for ambiguous phrasing.
 */
export function hasActiveSafetySignal(summary: string): boolean {
  return splitClauses(summary).some((clause) => {
    if (hasTerms(clause, SELF_NEGATED_TERMS)) {
      return true;
    }

    let scrubbed = clause;
    for (const phrase of SERVICE_PHRASES) {
      scrubbed = scrubbed.replace(new RegExp(phrase, 'gi'), ' ');
    }

    if (!hasTerms(scrubbed, EMERGENCY_TERMS)) {
      return false;
    }

    return !(
      containsCue(clause, NEGATION_CUES) ||
      containsCue(clause, NARRATION_CUES) ||
      containsCue(clause, OFFER_CUES)
    );
  });
}

export function classify(summary: string, reportedIntent?: Intent): Classification {
  // Backstop: an active, non-negated safety signal escalates even if the model
  // under-called it. Keywords may only escalate -- never downgrade the model.
  if (hasActiveSafetySignal(summary)) {
    return {
      intent: 'EMERGENCY',
      confidence: 0.95,
      reason: 'Active safety signal detected; treated as emergency',
    };
  }

  // The model has the conversation in context, including corrections a keyword
  // scan cannot see ('actually, it is not an emergency'), so its call wins.
  if (reportedIntent) {
    return {
      intent: reportedIntent,
      confidence: 0.9,
      reason: 'Classified by the assistant from conversation context',
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
