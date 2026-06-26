import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
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
  private readonly client: OpenAI;

  constructor(private readonly config: AppConfig) {
    this.client = new OpenAI({ apiKey: config.openAiApiKey, timeout: config.openAiTimeoutMs });
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
    return this.config.openAiModel;
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
    const response = await this.client.responses.create({
      model: this.config.openAiModel,
      instructions,
      input: JSON.stringify(input),
      text: {
        format: {
          type: 'json_schema',
          name: schemaName,
          strict: true,
          schema,
        },
      },
    });
    if (!response.output_text) throw new Error('OpenAI returned no structured output');
    return JSON.parse(response.output_text) as unknown;
  }
}
