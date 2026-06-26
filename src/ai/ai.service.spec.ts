import { AiService } from './ai.service';
import { ClientScenario } from './ai.types';

type JsonParser = { parseJsonObject(text: string): unknown };
type ScenarioFallback = {
  fallbackScenario(input: {
    topic: 'stripe_invoice_issue';
    tone: 'polite';
    level: 'junior';
  }): ClientScenario;
};

describe('AiService structured JSON parsing', () => {
  const parser = Object.create(AiService.prototype) as JsonParser;

  it('extracts a JSON object after an unwanted Gemini preface', () => {
    expect(
      parser.parseJsonObject('Here is the JSON you requested:\n{"topic":"bug_report"}'),
    ).toEqual({
      topic: 'bug_report',
    });
  });

  it('extracts a JSON object from a Markdown fence', () => {
    expect(parser.parseJsonObject('```json\n{"score":7}\n```')).toEqual({ score: 7 });
  });

  it('reports invalid model output without exposing the whole response', () => {
    expect(() => parser.parseJsonObject('Here is your answer, but not JSON.')).toThrow(
      'Gemini returned invalid JSON',
    );
  });

  it('keeps practice available with a local fallback scenario', () => {
    const fallback = Object.create(AiService.prototype) as ScenarioFallback;
    expect(
      fallback.fallbackScenario({
        topic: 'stripe_invoice_issue',
        tone: 'polite',
        level: 'junior',
      }),
    ).toMatchObject({
      topic: 'stripe_invoice_issue',
      tone: 'polite',
      difficulty: 'junior',
    });
  });
});
