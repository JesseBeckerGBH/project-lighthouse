import { getConfig } from '../config';
import { Result, ok, err } from '../errors';

type KnownFact = 'hours' | 'area' | 'name' | 'timezone' | 'services';

// Deliberately narrow: a question about the service list is answerable, but a question
// about one specific unlisted service is not, so it must fall through to FACT_NOT_CONFIGURED.
const SERVICE_LIST_PHRASES = [
  'what services',
  'services do you',
  'services you offer',
  'what do you offer',
  'kind of work',
  'type of work',
];

function mapQuestionToFact(question: string): KnownFact | null {
  const q = question.toLowerCase().trim();
  if (SERVICE_LIST_PHRASES.some((phrase) => q.includes(phrase))) {
    return 'services';
  }
  if (q.includes('hour') || q.includes('open') || q.includes('time') || q.includes('when')) {
    return 'hours';
  }
  if (q.includes('area') || q.includes('location') || q.includes('city') || q.includes('serve')) {
    return 'area';
  }
  if (q.includes('name') || q.includes('who') || q.includes('business')) {
    return 'name';
  }
  if (q.includes('timezone') || q.includes('zone')) {
    return 'timezone';
  }
  return null;
}

export function answerBusinessQuestion(question: string): Result<string> {
  const fact = mapQuestionToFact(question);
  const config = getConfig();

  if (!fact) {
    return err('FACT_NOT_CONFIGURED', 'That business fact is not configured.');
  }

  switch (fact) {
    case 'hours':
      return ok(config.businessHours);
    case 'area':
      return ok(config.businessServiceArea);
    case 'name':
      return ok(config.businessName);
    case 'timezone':
      return ok(config.businessTimezone);
    case 'services':
      return ok(config.businessServices);
    default:
      return err('FACT_NOT_CONFIGURED', 'That business fact is not configured.');
  }
}
