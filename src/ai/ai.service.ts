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
    const result = await this.createStructuredResponse(
      CLIENT_INSTRUCTIONS,
      input,
      'client_scenario',
      clientScenarioJsonSchema,
    );
    assertClientScenario(result);
    return result;
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
      'reply_evaluation',
      evaluationJsonSchema,
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
    schemaName: string,
    schema: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.client.models.generateContent({
      model: this.config.geminiModel,
      contents: JSON.stringify({ schemaName, input }),
      config: {
        systemInstruction: instructions,
        responseMimeType: 'application/json',
        responseJsonSchema: schema,
      },
    });
    if (!response.text) throw new Error('Gemini returned no structured output');
    return JSON.parse(response.text) as unknown;
  }
}
