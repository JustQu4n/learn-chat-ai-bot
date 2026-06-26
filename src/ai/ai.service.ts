import { Injectable } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { AppConfig } from '../config/app-config.service';
import {
  assertClientScenario,
  assertEvaluation,
  clientScenarioJsonSchema,
  evaluationJsonSchema,
} from './ai.schemas';
import {
  ClientScenario,
  ClientTone,
  EvaluationResult,
  PracticeLevelValue,
  Topic,
} from './ai.types';
import {
  CLIENT_INSTRUCTIONS,
  CLIENT_PROMPT_VERSION,
  EVALUATOR_INSTRUCTIONS,
  EVALUATOR_PROMPT_VERSION,
} from './prompts';

const SCENARIO_MAX_OUTPUT_TOKENS = 512;
const EVALUATION_MAX_OUTPUT_TOKENS = 768;

export interface AiServicePort {
  generateScenario(input: {
    topic: Topic;
    tone: ClientTone;
    level: PracticeLevelValue;
  }): Promise<ClientScenario>;
  evaluateReply(input: {
    clientMessage: string;
    userReply: string;
    level: PracticeLevelValue;
    topic: Topic;
  }): Promise<EvaluationResult>;
}

@Injectable()
export class AiService implements AiServicePort {
  private readonly client: GoogleGenAI;

  constructor(private readonly config: AppConfig) {
    this.client = new GoogleGenAI({ apiKey: config.geminiApiKey });
  }

  async generateScenario(input: {
    topic: Topic;
    tone: ClientTone;
    level: PracticeLevelValue;
  }): Promise<ClientScenario> {
    try {
      const result = await this.createStructuredResponse(
        CLIENT_INSTRUCTIONS,
        input,
        clientScenarioJsonSchema,
        SCENARIO_MAX_OUTPUT_TOKENS,
      );
      assertClientScenario(result);
      return result;
    } catch {
      return this.fallbackScenario(input);
    }
  }

  async evaluateReply(input: {
    clientMessage: string;
    userReply: string;
    level: PracticeLevelValue;
    topic: Topic;
  }): Promise<EvaluationResult> {
    const result = await this.createStructuredResponse(
      EVALUATOR_INSTRUCTIONS,
      input,
      evaluationJsonSchema,
      EVALUATION_MAX_OUTPUT_TOKENS,
    );
    assertEvaluation(result);
    return result;
  }

  get model() {
    return this.config.geminiModel;
  }

  get promptVersions() {
    return { client: CLIENT_PROMPT_VERSION, evaluator: EVALUATOR_PROMPT_VERSION };
  }

  private async createStructuredResponse(
    instructions: string,
    input: object,
    schema: Record<string, unknown>,
    maxOutputTokens: number,
  ): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await this.client.models.generateContent({
          model: this.config.geminiModel,
          contents: JSON.stringify(input),
          config: {
            systemInstruction:
              attempt === 1
                ? instructions
                : `${instructions}\nCRITICAL: Your previous response was not valid JSON. Start your response with { and end it with }.`,
            responseMimeType: 'application/json',
            responseJsonSchema: schema,
            maxOutputTokens,
            temperature: 0,
            thinkingConfig: { thinkingBudget: 0 },
          },
        });
        if (!response.text) throw new Error('Gemini returned no structured output');
        return this.parseJsonObject(response.text);
      } catch (error) {
        lastError = error;
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Gemini structured output failed after two attempts: ${message}`);
  }

  private parseJsonObject(text: string): unknown {
    const withoutFences = text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    const firstBrace = withoutFences.indexOf('{');
    const lastBrace = withoutFences.lastIndexOf('}');
    const json =
      firstBrace >= 0 && lastBrace > firstBrace
        ? withoutFences.slice(firstBrace, lastBrace + 1)
        : withoutFences;

    try {
      return JSON.parse(json) as unknown;
    } catch {
      const preview = withoutFences.replace(/\s+/g, ' ').slice(0, 160);
      throw new Error(`Gemini returned invalid JSON: ${preview}`);
    }
  }

  private fallbackScenario(input: {
    topic: Topic;
    tone: ClientTone;
    level: PracticeLevelValue;
  }): ClientScenario {
    const messages: Record<Topic, string> = {
      api_progress_update: 'Could you share a brief update on the API work and any blockers?',
      bug_report:
        'We are seeing an issue in production. Could you confirm what you are investigating?',
      pr_review_comment:
        'Could you address the PR comments and let me know when the update is ready?',
      deadline_concern: 'Are we still on track for the deadline, or do you see any risks?',
      requirement_clarification:
        'Could you clarify which user flow should be prioritized for this requirement?',
      payment_subscription_issue:
        'A customer reported a subscription issue. Do you have an initial update?',
      stripe_invoice_issue:
        'Could you check the Stripe invoice status mapping and share your findings?',
      database_performance:
        'We noticed slower database queries. What is your current investigation plan?',
      redis_cache_issue: 'The cache does not appear to refresh correctly. Could you look into it?',
      deployment_problem:
        'The latest deployment did not complete as expected. What is the current status?',
      daily_standup: 'What did you complete yesterday, and what are you focusing on today?',
      estimate_task: 'Could you provide a rough estimate and note any assumptions for this task?',
      explain_technical_issue:
        'Could you explain the technical issue and its impact in simple terms?',
      client_update: 'Could you send a concise update on the current progress and any blockers?',
    };
    return {
      topic: input.topic,
      tone: input.tone,
      difficulty: input.level,
      message: messages[input.topic],
    };
  }
}
