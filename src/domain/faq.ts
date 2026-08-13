import { getConfig } from '../config';
import { Result, ok, err } from '../errors';

type KnownFact = 'hours' | 'area' | 'name' | 'timezone';

function mapQuestionToFact(question: string): KnownFact | null {
  const q = question.toLowerCase().trim();
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
    default:
      return err('FACT_NOT_CONFIGURED', 'That business fact is not configured.');
  }
}
