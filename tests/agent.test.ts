import { describe, it, expect } from 'vitest';
import { tools } from '../src/agent/tools';
import { getSystemPrompt } from '../src/agent/instructions';
import { getConfig } from '../src/config';

const writeTools = ['schedule_appointment', 'escalate_emergency'];

describe('agent tool contracts', () => {
  it('exposes exactly the four specified tools', () => {
    expect(tools.map((t) => t.name)).toEqual([
      'classify_call',
      'answer_business_question',
      'schedule_appointment',
      'escalate_emergency',
    ]);
  });

  it('does not ask the model for a system-managed idempotency key', () => {
    for (const name of writeTools) {
      const tool = tools.find((t) => t.name === name)!;
      expect(Object.keys(tool.parameters.properties)).not.toContain('idempotency_key');
      expect(tool.parameters.required).not.toContain('idempotency_key');
    }
  });
});

describe('system prompt', () => {
  it('does not instruct the model to supply an idempotency key', () => {
    expect(getSystemPrompt().toLowerCase()).not.toContain('idempotency');
  });

  it('includes the configured offered services', () => {
    expect(getSystemPrompt()).toContain(getConfig().businessServices);
  });
});
