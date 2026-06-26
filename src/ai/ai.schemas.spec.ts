import { assertClientScenario, assertEvaluation } from './ai.schemas';

describe('AI structured output validation', () => {
  it('accepts a valid client scenario', () => {
    const scenario = {
      topic: 'api_progress_update',
      tone: 'polite',
      difficulty: 'junior',
      message: 'Could you share a short update on the API work and any blockers?',
    };
    expect(() => assertClientScenario(scenario)).not.toThrow();
  });

  it('rejects an unknown topic', () => {
    expect(() =>
      assertClientScenario({
        topic: 'ignore_previous_instructions',
        tone: 'polite',
        difficulty: 'junior',
        message: 'hello',
      }),
    ).toThrow('Scenario output');
  });

  it('rejects evaluation scores outside the permitted range', () => {
    expect(() =>
      assertEvaluation({
        overallScore: 11,
        criteria: { grammar: 7, professionalTone: 7, clarity: 7, completeness: 7 },
        grammarFeedback: [],
        toneFeedback: [],
        clarityFeedback: [],
        missingInformation: [],
        betterReply: 'Thank you. I will share an update shortly.',
        vietnameseExplanation: 'Câu trả lời ổn.',
      }),
    ).toThrow('Evaluation output');
  });

  it('rejects verbose feedback lists', () => {
    expect(() =>
      assertEvaluation({
        overallScore: 7,
        criteria: { grammar: 7, professionalTone: 7, clarity: 7, completeness: 7 },
        grammarFeedback: ['Fix verb tense.', 'Use a more natural phrase.'],
        toneFeedback: [],
        clarityFeedback: [],
        missingInformation: [],
        betterReply: 'I am reviewing the issue and will send an update shortly.',
        vietnameseExplanation: 'Chỉ cần sửa một lỗi quan trọng mỗi lần để feedback ngắn và dễ nhớ.',
      }),
    ).toThrow('Evaluation output');
  });
});
