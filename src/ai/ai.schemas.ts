import { ClientScenario, EvaluationResult, TOPICS } from './ai.types';

const score = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10;

const shortText = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;

const stringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 1 && value.every((item) => shortText(item, 180));

export const clientScenarioJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['topic', 'tone', 'difficulty', 'message'],
  properties: {
    topic: { type: 'string', enum: [...TOPICS] },
    tone: { type: 'string', enum: ['polite', 'urgent', 'confused', 'casual'] },
    difficulty: { type: 'string', enum: ['intern', 'fresher', 'junior'] },
    message: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const;

export const evaluationJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'overallScore',
    'criteria',
    'grammarFeedback',
    'toneFeedback',
    'clarityFeedback',
    'missingInformation',
    'betterReply',
    'vietnameseExplanation',
  ],
  properties: {
    overallScore: { type: 'number', minimum: 0, maximum: 10 },
    criteria: {
      type: 'object',
      additionalProperties: false,
      required: ['grammar', 'professionalTone', 'clarity', 'completeness'],
      properties: {
        grammar: { type: 'number', minimum: 0, maximum: 10 },
        professionalTone: { type: 'number', minimum: 0, maximum: 10 },
        clarity: { type: 'number', minimum: 0, maximum: 10 },
        completeness: { type: 'number', minimum: 0, maximum: 10 },
      },
    },
    grammarFeedback: { type: 'array', items: { type: 'string' }, maxItems: 1 },
    toneFeedback: { type: 'array', items: { type: 'string' }, maxItems: 1 },
    clarityFeedback: { type: 'array', items: { type: 'string' }, maxItems: 1 },
    missingInformation: { type: 'array', items: { type: 'string' }, maxItems: 1 },
    betterReply: { type: 'string', minLength: 1, maxLength: 500 },
    vietnameseExplanation: { type: 'string', minLength: 1, maxLength: 300 },
  },
} as const;

export function assertClientScenario(value: unknown): asserts value is ClientScenario {
  if (!value || typeof value !== 'object') throw new Error('Scenario output must be an object');
  const candidate = value as Record<string, unknown>;
  if (
    !TOPICS.includes(candidate.topic as (typeof TOPICS)[number]) ||
    !['polite', 'urgent', 'confused', 'casual'].includes(candidate.tone as string) ||
    !['intern', 'fresher', 'junior'].includes(candidate.difficulty as string) ||
    !shortText(candidate.message, 500)
  ) {
    throw new Error('Scenario output does not match the expected schema');
  }
}

export function assertEvaluation(value: unknown): asserts value is EvaluationResult {
  if (!value || typeof value !== 'object') throw new Error('Evaluation output must be an object');
  const candidate = value as Record<string, unknown>;
  const criteria = candidate.criteria as Record<string, unknown> | undefined;
  if (
    !score(candidate.overallScore) ||
    !criteria ||
    !score(criteria.grammar) ||
    !score(criteria.professionalTone) ||
    !score(criteria.clarity) ||
    !score(criteria.completeness) ||
    !stringList(candidate.grammarFeedback) ||
    !stringList(candidate.toneFeedback) ||
    !stringList(candidate.clarityFeedback) ||
    !stringList(candidate.missingInformation) ||
    !shortText(candidate.betterReply, 500) ||
    !shortText(candidate.vietnameseExplanation, 300)
  ) {
    throw new Error('Evaluation output does not match the expected schema');
  }
}
