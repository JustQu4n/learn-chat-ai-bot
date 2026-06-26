import { AiService } from './ai.service';

type JsonParser = { parseJsonObject(text: string): unknown };

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
});
