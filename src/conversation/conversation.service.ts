import { Injectable, Logger } from '@nestjs/common';
import {
  Evaluation,
  PracticeLevel,
  PracticeSession,
  PracticeSessionStatus,
  Prisma,
  TelegramUpdateStatus,
} from '@prisma/client';
import { AiService } from '../ai/ai.service';
import { ClientTone, EvaluationResult, PracticeLevelValue, TOPICS, Topic } from '../ai/ai.types';
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
  ) {}

  async registerUser(telegramId: bigint, username?: string) {
    return this.prisma.user.upsert({
      where: { telegramId },
      create: {
        telegramId,
        telegramUsername: username ?? null,
        timezone: this.config.defaultTimezone,
      },
      update: username ? { telegramUsername: username } : {},
    });
  }

  async startPracticeWelcome(telegramId: bigint, chatId: bigint) {
    await this.registerUser(telegramId);
    await this.telegram.sendText(
      chatId,
      'Welcome! I will play the client and help you practise professional English. Use /practice to begin an exercise. Reply in English, then I will score it and suggest a stronger version.\n\nCommands: /practice, /skip, /retry, /history, /help',
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

  async startPractice(input: { telegramId: bigint; chatId: bigint; requestedTopic?: string }) {
    const user = await this.registerUser(input.telegramId);
    const active = await this.prisma.practiceSession.findFirst({
      where: { userId: user.id, status: { in: ACTIVE_STATUSES } },
      orderBy: { createdAt: 'desc' },
    });
    if (active) {
      await this.telegram.sendText(
        input.chatId,
        'You already have an active exercise. Reply to it, or use /skip first.',
      );
      return;
    }

    const topic = this.resolveTopic(input.requestedTopic);
    let session: PracticeSession;
    try {
      session = await this.prisma.practiceSession.create({
        data: {
          userId: user.id,
          status: PracticeSessionStatus.GENERATING,
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
        return;
      }
      throw error;
    }

    try {
      const scenario = await this.ai.generateScenario({
        topic,
        tone: this.randomTone(),
        level: this.toLevelValue(user.level),
      });
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
    } catch (error) {
      await this.prisma.practiceSession.update({
        where: { id: session.id },
        data: { status: PracticeSessionStatus.GENERATION_FAILED },
      });
      this.logger.error(`Scenario generation failed for session ${session.id}`);
      await this.telegram.sendText(
        input.chatId,
        'I could not create an exercise right now. Please try /practice again shortly.',
      );
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

    const user = await this.registerUser(input.telegramId);
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
    const user = await this.registerUser(telegramId);
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
    const user = await this.registerUser(telegramId);
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
    const user = await this.registerUser(telegramId);
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

  private resolveTopic(requestedTopic?: string): Topic {
    if (requestedTopic && TOPICS.includes(requestedTopic as Topic)) return requestedTopic as Topic;
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
    return [
      `Score: ${result.overallScore.toFixed(1)}/10`,
      `Grammar: ${result.criteria.grammar.toFixed(1)} · Tone: ${result.criteria.professionalTone.toFixed(1)} · Clarity: ${result.criteria.clarity.toFixed(1)} · Completeness: ${result.criteria.completeness.toFixed(1)}`,
      `Better version:\n${result.betterReply}`,
      this.renderBulletSection('Grammar feedback', result.grammarFeedback),
      this.renderBulletSection('Tone feedback', result.toneFeedback),
      this.renderBulletSection('Clarity feedback', result.clarityFeedback),
      this.renderBulletSection('Missing information', result.missingInformation),
      `Giải thích:\n${result.vietnameseExplanation}`,
    ].join('\n\n');
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

  private renderBulletSection(title: string, entries: string[]) {
    return `${title}:\n${entries.length ? entries.map((entry) => `- ${entry}`).join('\n') : '- None identified.'}`;
  }

  private isUniqueConstraint(error: unknown) {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}
