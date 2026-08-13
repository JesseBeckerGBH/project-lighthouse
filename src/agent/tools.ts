export interface ToolParameter {
  type: string;
  description: string;
  enum?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required: string[];
  };
}

// Exactly the four workflow tools defined in the specification.
export const tools: ToolDefinition[] = [
  {
    name: 'classify_call',
    description: 'Classify the caller\'s intent as EMERGENCY, NEW_LEAD, EXISTING_CUSTOMER, or GENERAL_QUESTION.',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'A brief, sanitized summary of the caller\'s request.',
        },
      },
      required: ['summary'],
    },
  },
  {
    name: 'answer_business_question',
    description: 'Answer a question using only configured business facts. Never guess.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The normalized caller question.',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'schedule_appointment',
    description: 'Create a fake demo appointment after the caller explicitly confirms. Not a real booking.',
    parameters: {
      type: 'object',
      properties: {
        caller_name: { type: 'string', description: 'Caller\'s name.' },
        callback_number: { type: 'string', description: 'Callback phone number.' },
        service_summary: { type: 'string', description: 'Short service summary.' },
        requested_slot: {
          type: 'object',
          description: 'Requested date and time window.',
        },
        confirmed: { type: 'boolean', description: 'Must be true after reading details back.' },
        idempotency_key: {
          type: 'string',
          description: 'System-managed idempotency key; provided by the platform.',
        },
      },
      required: [
        'caller_name',
        'callback_number',
        'service_summary',
        'requested_slot',
        'confirmed',
        'idempotency_key',
      ],
    },
  },
  {
    name: 'escalate_emergency',
    description: 'Record an emergency and notify the owner. Do not claim dispatch.',
    parameters: {
      type: 'object',
      properties: {
        callback_number: { type: 'string', description: 'Callback number.' },
        situation_summary: { type: 'string', description: 'Sanitized situation summary.' },
        location: { type: 'string', description: 'Location if voluntarily provided.' },
        confirmed: { type: 'boolean', description: 'Acknowledgment; not required to record the escalation.' },
        idempotency_key: {
          type: 'string',
          description: 'System-managed idempotency key; provided by the platform.',
        },
      },
      required: ['callback_number', 'situation_summary', 'confirmed', 'idempotency_key'],
    },
  },
];
