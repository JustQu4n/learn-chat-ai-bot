import { Injectable, Logger } from '@nestjs/common';
import {
  Evaluation,
  PracticeLevel,
  PracticeSource,
  PracticeSession,
  PracticeSessionStatus,
  Prisma,
  TelegramUpdateStatus,
} from '@prisma/client';
import { AiService } from '../ai/ai.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { DashboardService } from '../analytics/dashboard.service';
import {
  ClientScenario,
  ClientTone,
  EvaluationResult,
  PracticeLevelValue,
  TOPICS,
  Topic,
} from '../ai/ai.types';
import { AppConfig } from '../config/app-config.service';
import { PrismaService } from '../persistence/prisma.service';
import { TelegramGateway } from '../telegram/telegram.gateway';

const ACTIVE_STATUSES: PracticeSessionStatus[] = [
  PracticeSessionStatus.GENERATING,
  PracticeSessionStatus.WAITING_REPLY,
  PracticeSessionStatus.EVALUATING,
];

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly telegram: TelegramGateway,
    private readonly config: AppConfig,
    private readonly analytics: AnalyticsService,
    private readonly dashboard: DashboardService,
  ) {}

  async registerUser(telegramId: bigint, username?: string, chatId?: bigint) {
    return this.prisma.user.upsert({
      where: { telegramId },
      create: {
        telegramId,
        telegramUsername: username ?? null,
        lastChatId: chatId ?? null,
        timezone: this.config.defaultTimezone,
      },
      update: {
        ...(username ? { telegramUsername: username } : {}),
        ...(chatId ? { lastChatId: chatId } : {}),
      },
    });
  }

  async startPracticeWelcome(telegramId: bigint, chatId: bigint) {
    await this.registerUser(telegramId, undefined, chatId);
    await this.telegram.sendText(
      chatId,
      'Welcome! Use /practice to begin an exercise. I will score your reply and suggest a stronger version.\n\nCommands: /practice, /level, /topic, /history, /stats, /schedule, /dashboard, /help',
    );
  }

  async showHelp(chatId: bigint) {
    await this.telegram.sendText(
      chatId,
      'Commands:\n/practice [topic] — start an exercise\n/skip — discard the active exercise\n/retry — retry a failed review\n/history [id] — view recent exercises\n\nTopics include api_progress_update, bug_report, pr_review_comment, deadline_concern, and stripe_invoice_issue.',
    );
  }

  async showUnknownCommand(chatId: bigint) {
    await this.telegram.sendText(
      chatId,
      'I do not know that command. Use /help to see available commands.',
    );
  }

  async sendPlainText(chatId: bigint, text: string) {
    await this.telegram.sendText(chatId, text);
  }

  async showSchedulerUsage(chatId: bigint) {
    await this.telegram.sendText(chatId, 'Usage: /schedule on [1-3] or /schedule off');
  }

  async startPractice(input: {
    telegramId: bigint;
    chatId: bigint;
    requestedTopic?: string;
    source?: PracticeSource;
    silentIfActive?: boolean;
  }): Promise<boolean> {
    const user = await this.registerUser(input.telegramId, undefined, input.chatId);
    const active = await this.prisma.practiceSession.findFirst({
      where: { userId: user.id, status: { in: ACTIVE_STATUSES } },
      orderBy: { createdAt: 'desc' },
    });
    if (active) {
      if (!input.silentIfActive) {
        await this.telegram.sendText(
          input.chatId,
          'You already have an active exercise. Reply to it, or use /skip first.',
        );
      }
      return false;
    }

    const topic = this.resolveTopic(input.requestedTopic, user.preferredTopics);
    let session: PracticeSession;
    try {
      session = await this.prisma.practiceSession.create({
        data: {
          userId: user.id,
          status: PracticeSessionStatus.GENERATING,
          source: input.source ?? PracticeSource.MANUAL,
          topic,
          telegramChatId: input.chatId,
        },
      });
    } catch (error) {
      if (this.isUniqueConstraint(error)) {
        await this.telegram.sendText(
          input.chatId,
          'You already have an active exercise. Reply to it, or use /skip first.',
        );
        return false;
      }
      throw error;
    }

    let scenario: ClientScenario;
    try {
      scenario = await this.ai.generateScenario({
        topic,
        tone: this.randomTone(),
        level: this.toLevelValue(user.level),
        projectContext: user.projectContext,
      });
    } catch (error) {
      await this.markGenerationFailed(session.id);
      this.logExternalFailure('AI scenario generation', session.id, error);
      await this.telegram.sendText(
        input.chatId,
        'I could not create an exercise right now. Please try /practice again shortly.',
      );
      return false;
    }

    try {
      const sent = await this.telegram.sendText(
        input.chatId,
        `Client message:\n\n${scenario.message}\n\nReply to this message in English.`,
      );
      await this.prisma.practiceSession.update({
        where: { id: session.id },
        data: {
          status: PracticeSessionStatus.WAITING_REPLY,
          clientTone: scenario.tone,
          clientMessage: scenario.message,
          telegramClientMessageId: BigInt(sent.messageId),
        },
      });
      return true;
    } catch (error) {
      await this.markGenerationFailed(session.id);
      this.logExternalFailure('Telegram scenario delivery', session.id, error);
      await this.telegram.sendText(
        input.chatId,
        'I could not create an exercise right now. Please try /practice again shortly.',
      );
      return false;
    }
  }

  async receiveReply(input: {
    telegramId: bigint;
    chatId: bigint;
    text: string;
    replyToMessageId?: number;
  }) {
    if (!this.isUsableReply(input.text)) {
      await this.telegram.sendText(
        input.chatId,
        'Please send a text reply in English (up to 4,000 characters).',
      );
      return;
    }

    const user = await this.registerUser(input.telegramId, undefined, input.chatId);
    const session = await this.findWaitingSession(user.id, input.chatId, input.replyToMessageId);
    if (!session) {
      await this.telegram.sendText(input.chatId, 'Please start a new exercise with /practice.');
      return;
    }

    const claimed = await this.prisma.practiceSession.updateMany({
      where: { id: session.id, status: PracticeSessionStatus.WAITING_REPLY },
      data: {
        status: PracticeSessionStatus.EVALUATING,
        userReply: input.text.trim(),
        replyReceivedAt: new Date(),
        fallbackBoundReply: !input.replyToMessageId,
      },
    });
    if (claimed.count === 0) return;

    await this.telegram.sendText(input.chatId, 'I’m reviewing your reply…');
    await this.evaluateAndDeliver(session.id, input.chatId, this.toLevelValue(user.level));
  }

  async skipPractice(telegramId: bigint, chatId: bigint) {
    const user = await this.registerUser(telegramId, undefined, chatId);
    const result = await this.prisma.practiceSession.updateMany({
      where: { userId: user.id, status: { in: ACTIVE_STATUSES } },
      data: { status: PracticeSessionStatus.SKIPPED, completedAt: new Date() },
    });
    await this.telegram.sendText(
      chatId,
      result.count
        ? 'Exercise skipped. Use /practice when you are ready.'
        : 'You do not have an active exercise.',
    );
  }

  async retryEvaluation(telegramId: bigint, chatId: bigint) {
    const user = await this.registerUser(telegramId, undefined, chatId);
    const session = await this.prisma.practiceSession.findFirst({
      where: { userId: user.id, status: PracticeSessionStatus.EVALUATION_FAILED },
      orderBy: { createdAt: 'desc' },
    });
    if (!session?.userReply) {
      await this.telegram.sendText(chatId, 'There is no failed review to retry.');
      return;
    }
    const claimed = await this.prisma.practiceSession.updateMany({
      where: { id: session.id, status: PracticeSessionStatus.EVALUATION_FAILED },
      data: { status: PracticeSessionStatus.EVALUATING },
    });
    if (claimed.count === 0) return;
    await this.telegram.sendText(chatId, 'Retrying your review…');
    await this.evaluateAndDeliver(session.id, chatId, this.toLevelValue(user.level));
  }

  async showHistory(telegramId: bigint, chatId: bigint, sessionId?: string) {
    const user = await this.registerUser(telegramId, undefined, chatId);
    if (sessionId) {
      const session = await this.prisma.practiceSession.findFirst({
        where: { id: sessionId, userId: user.id },
        include: { evaluation: true },
      });
      await this.telegram.sendText(
        chatId,
        session
          ? this.renderHistoryDetail(session)
          : 'I could not find that exercise in your history.',
      );
      return;
    }

    const sessions = await this.prisma.practiceSession.findMany({
      where: { userId: user.id },
      include: { evaluation: true },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    if (sessions.length === 0) {
      await this.telegram.sendText(chatId, 'No practice history yet. Start with /practice.');
      return;
    }
    const rows = sessions.map((session) => {
      const score = session.evaluation ? Number(session.evaluation.overallScore).toFixed(1) : '—';
      return `${session.id}\n${session.topic} · ${session.status.toLowerCase()} · ${score}/10`;
    });
    await this.telegram.sendText(
      chatId,
      `Your latest exercises:\n\n${rows.join('\n\n')}\n\nUse /history <id> for details.`,
    );
  }

  async setLevel(telegramId: bigint, chatId: bigint, requestedLevel?: string) {
    const level = requestedLevel?.toUpperCase();
    if (!level || !['INTERN', 'FRESHER', 'JUNIOR'].includes(level)) {
      await this.telegram.sendText(chatId, 'Usage: /level intern, fresher, or junior');
      return;
    }
    await this.prisma.user.update({
      where: { telegramId },
      data: { level: level as PracticeLevel },
    });
    await this.telegram.sendText(chatId, `Level saved: ${level.toLowerCase()}.`);
  }

  async setTopicPreference(telegramId: bigint, chatId: bigint, requestedTopic?: string) {
    if (!requestedTopic || requestedTopic === 'all') {
      await this.prisma.user.update({ where: { telegramId }, data: { preferredTopics: [] } });
      await this.telegram.sendText(
        chatId,
        'Topic preference cleared. I will choose from all topics.',
      );
      return;
    }
    if (!TOPICS.includes(requestedTopic as Topic)) {
      await this.telegram.sendText(chatId, `Unknown topic. Use /topics to see options.`);
      return;
    }
    await this.prisma.user.update({
      where: { telegramId },
      data: { preferredTopics: [requestedTopic] },
    });
    await this.telegram.sendText(chatId, `Topic preference saved: ${requestedTopic}.`);
  }

  async setProjectContext(telegramId: bigint, chatId: bigint, text?: string) {
    if (!text || text.toLowerCase() === 'clear') {
      await this.prisma.user.update({ where: { telegramId }, data: { projectContext: null } });
      await this.telegram.sendText(chatId, 'Project context cleared.');
      return;
    }
    if (text.length > 800) {
      await this.telegram.sendText(chatId, 'Project context must be 800 characters or fewer.');
      return;
    }
    await this.prisma.user.update({ where: { telegramId }, data: { projectContext: text } });
    await this.telegram.sendText(
      chatId,
      'Project context saved for future scenarios. Do not include secrets.',
    );
  }

  async showTopics(chatId: bigint) {
    await this.telegram.sendText(
      chatId,
      `Topics:\n${TOPICS.map((topic) => `- ${topic}`).join('\n')}`,
    );
  }

  async showStats(telegramId: bigint, chatId: bigint) {
    const user = await this.registerUser(telegramId, undefined, chatId);
    const stats = await this.analytics.getStats(user.id, user.timezone);
    await this.telegram.sendText(
      chatId,
      `📈 Practice stats\n\nCompleted: ${stats.completedCount}\nAverage: ${stats.averageScore ?? '—'}/10\nLast 7 days: ${stats.sevenDayAverage ?? '—'}/10\nStreak: ${stats.streakDays} day(s)\n\nCommon areas: Grammar ${stats.categoryCounts.grammar} · Tone ${stats.categoryCounts.tone} · Clarity ${stats.categoryCounts.clarity} · Missing details ${stats.categoryCounts.missing}`,
    );
  }

  async sendDashboardLink(telegramId: bigint, chatId: bigint) {
    const user = await this.registerUser(telegramId, undefined, chatId);
    const link = await this.dashboard.createLink(user.id);
    await this.telegram.sendText(
      chatId,
      link
        ? `Your private dashboard link (valid for 15 minutes):\n${link}`
        : 'Dashboard is not configured yet. Set PUBLIC_BASE_URL in the server environment.',
    );
  }

  async deleteMyData(telegramId: bigint, chatId: bigint) {
    await this.prisma.$transaction([
      this.prisma.telegramUpdate.deleteMany({ where: { telegramId } }),
      this.prisma.user.deleteMany({ where: { telegramId } }),
    ]);
    await this.telegram.sendText(
      chatId,
      'Your practice data has been deleted. Use /start to create a new profile.',
    );
  }

  async claimTelegramUpdate(updateId: number, telegramId?: bigint): Promise<boolean> {
    try {
      await this.prisma.telegramUpdate.create({
        data: { updateId: BigInt(updateId), telegramId: telegramId ?? null },
      });
      return true;
    } catch (error) {
      if (this.isUniqueConstraint(error)) return false;
      throw error;
    }
  }

  async markTelegramUpdate(updateId: number, success: boolean) {
    await this.prisma.telegramUpdate.update({
      where: { updateId: BigInt(updateId) },
      data: {
        processingStatus: success ? TelegramUpdateStatus.PROCESSED : TelegramUpdateStatus.FAILED,
        processedAt: new Date(),
      },
    });
  }

  private async evaluateAndDeliver(sessionId: string, chatId: bigint, level: PracticeLevelValue) {
    const session = await this.prisma.practiceSession.findUnique({ where: { id: sessionId } });
    if (!session?.clientMessage || !session.userReply) return;
    try {
      const evaluation = await this.ai.evaluateReply({
        clientMessage: session.clientMessage,
        userReply: session.userReply,
        level,
        topic: session.topic as Topic,
      });
      await this.persistEvaluation(sessionId, evaluation);
    } catch (error) {
      this.logger.error(`Evaluation failed for session ${sessionId}`);
      await this.prisma.practiceSession.updateMany({
        where: { id: sessionId, status: PracticeSessionStatus.EVALUATING },
        data: { status: PracticeSessionStatus.EVALUATION_FAILED },
      });
      await this.telegram.sendText(
        chatId,
        'I saved your reply but could not review it yet. Please use /retry shortly.',
      );
      return;
    }

    const completed = await this.prisma.practiceSession.findUnique({
      where: { id: sessionId },
      include: { evaluation: true },
    });
    if (!completed?.evaluation) return;
    try {
      await this.telegram.sendText(
        chatId,
        this.renderEvaluation({
          overallScore: Number(completed.evaluation.overallScore),
          criteria: completed.evaluation.criteria as EvaluationResult['criteria'],
          grammarFeedback:
            (completed.evaluation.feedback as Record<string, string[]>).grammarFeedback ?? [],
          toneFeedback:
            (completed.evaluation.feedback as Record<string, string[]>).toneFeedback ?? [],
          clarityFeedback:
            (completed.evaluation.feedback as Record<string, string[]>).clarityFeedback ?? [],
          missingInformation:
            (completed.evaluation.feedback as Record<string, string[]>).missingInformation ?? [],
          betterReply: completed.evaluation.betterReply,
          vietnameseExplanation: completed.evaluation.vietnameseExplanation,
        }),
      );
    } catch (error) {
      this.logger.error(`Feedback delivery failed for completed session ${sessionId}`);
    }
  }

  private async persistEvaluation(sessionId: string, evaluation: EvaluationResult) {
    await this.prisma.$transaction([
      this.prisma.evaluation.upsert({
        where: { practiceSessionId: sessionId },
        create: {
          practiceSessionId: sessionId,
          overallScore: new Prisma.Decimal(evaluation.overallScore),
          criteria: evaluation.criteria,
          feedback: {
            grammarFeedback: evaluation.grammarFeedback,
            toneFeedback: evaluation.toneFeedback,
            clarityFeedback: evaluation.clarityFeedback,
            missingInformation: evaluation.missingInformation,
          },
          betterReply: evaluation.betterReply,
          vietnameseExplanation: evaluation.vietnameseExplanation,
          model: this.ai.model,
          promptVersion: this.ai.promptVersions.evaluator,
        },
        update: {},
      }),
      this.prisma.practiceSession.update({
        where: { id: sessionId },
        data: { status: PracticeSessionStatus.COMPLETED, completedAt: new Date() },
      }),
    ]);
  }

  private async findWaitingSession(userId: string, chatId: bigint, replyToMessageId?: number) {
    if (replyToMessageId) {
      return this.prisma.practiceSession.findFirst({
        where: {
          userId,
          telegramChatId: chatId,
          telegramClientMessageId: BigInt(replyToMessageId),
          status: PracticeSessionStatus.WAITING_REPLY,
        },
      });
    }
    return this.prisma.practiceSession.findFirst({
      where: { userId, status: PracticeSessionStatus.WAITING_REPLY },
      orderBy: { createdAt: 'desc' },
    });
  }

  private resolveTopic(requestedTopic?: string, preferredTopics?: Prisma.JsonValue): Topic {
    if (requestedTopic && TOPICS.includes(requestedTopic as Topic)) return requestedTopic as Topic;
    if (Array.isArray(preferredTopics)) {
      const valid = preferredTopics.filter(
        (topic): topic is Topic => typeof topic === 'string' && TOPICS.includes(topic as Topic),
      );
      if (valid.length) return valid[Math.floor(Math.random() * valid.length)];
    }
    return TOPICS[Math.floor(Math.random() * TOPICS.length)];
  }

  private randomTone(): ClientTone {
    const tones: ClientTone[] = ['polite', 'urgent', 'confused', 'casual'];
    return tones[Math.floor(Math.random() * tones.length)];
  }

  private toLevelValue(level: PracticeLevel): PracticeLevelValue {
    return level.toLowerCase() as PracticeLevelValue;
  }

  private isUsableReply(text: string) {
    const length = text.trim().length;
    return length > 0 && length <= 4000;
  }

  private renderEvaluation(result: EvaluationResult) {
    const improvements = this.compactImprovements(result).slice(0, 3);
    return [
      `📊 Score: ${result.overallScore.toFixed(1)}/10`,
      `Grammar ${result.criteria.grammar.toFixed(1)} · Tone ${result.criteria.professionalTone.toFixed(1)} · Clarity ${result.criteria.clarity.toFixed(1)} · Complete ${result.criteria.completeness.toFixed(1)}`,
      `✨ Better reply\n${result.betterReply}`,
      improvements.length
        ? `🔧 Improve\n${improvements.map((item) => `• ${item}`).join('\n')}`
        : '',
      `🇻🇳 ${result.vietnameseExplanation}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private renderHistoryDetail(session: PracticeSession & { evaluation: Evaluation | null }) {
    const evaluation = session.evaluation;
    const score = evaluation?.overallScore ? String(evaluation.overallScore) : 'Not available';
    return [
      `Topic: ${session.topic}`,
      `Status: ${session.status.toLowerCase()}`,
      `Score: ${score}`,
      session.clientMessage ? `Client message:\n${session.clientMessage}` : '',
      session.userReply ? `Your reply:\n${session.userReply}` : '',
      evaluation?.betterReply ? `Better version:\n${String(evaluation.betterReply)}` : '',
      evaluation?.vietnameseExplanation
        ? `Giải thích:\n${String(evaluation.vietnameseExplanation)}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private compactImprovements(result: EvaluationResult): string[] {
    return [
      ...result.grammarFeedback.map((item) => `Grammar: ${item}`),
      ...result.toneFeedback.map((item) => `Tone: ${item}`),
      ...result.clarityFeedback.map((item) => `Clarity: ${item}`),
      ...result.missingInformation.map((item) => `Missing: ${item}`),
    ];
  }

  private isUniqueConstraint(error: unknown) {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }

  private async markGenerationFailed(sessionId: string) {
    await this.prisma.practiceSession.update({
      where: { id: sessionId },
      data: { status: PracticeSessionStatus.GENERATION_FAILED },
    });
  }

  private logExternalFailure(operation: string, sessionId: string, error: unknown) {
    const details = this.errorDetails(error);
    this.logger.error(
      `${operation} failed for session ${sessionId}: ${details.message}`,
      details.stack,
    );
  }

  private errorDetails(error: unknown): { message: string; stack?: string } {
    if (error instanceof Error) {
      const status = this.readNumberProperty(error, 'status');
      const requestId = this.readStringProperty(error, 'request_id');
      return {
        message: `${status ? `HTTP ${status} ` : ''}${error.name}: ${error.message}${requestId ? ` (request_id: ${requestId})` : ''}`,
        stack: error.stack,
      };
    }
    return { message: String(error) };
  }

  private readNumberProperty(value: object, key: string): number | undefined {
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === 'number' ? candidate : undefined;
  }

  private readStringProperty(value: object, key: string): string | undefined {
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === 'string' ? candidate : undefined;
  }
}
