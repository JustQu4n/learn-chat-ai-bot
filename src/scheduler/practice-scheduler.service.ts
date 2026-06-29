import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MessageJobStatus, PracticeSource } from '@prisma/client';
import { ConnectionOptions, Job, Queue, Worker } from 'bullmq';
import { DateTime } from 'luxon';
import { AppConfig } from '../config/app-config.service';
import { ConversationService } from '../conversation/conversation.service';
import { PrismaService } from '../persistence/prisma.service';
import { ClientTone, TOPICS, Topic } from '../ai/ai.types';

type PracticeJobData = { messageJobId: string };

@Injectable()
export class PracticeSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PracticeSchedulerService.name);
  private connection?: ConnectionOptions;
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly conversation: ConversationService,
  ) {}

  async onModuleInit() {
    if (!this.config.schedulerEnabled) return;
    if (!this.config.redisUrl) {
      throw new Error('REDIS_URL is required when SCHEDULER_ENABLED=true');
    }
    const connection = this.redisConnection(this.config.redisUrl);
    this.connection = connection;
    this.queue = new Queue('practice-scheduler', { connection });
    this.worker = new Worker('practice-scheduler', async (job) => this.process(job), {
      connection,
    });
    this.worker.on('error', (error) => this.logger.error(`BullMQ worker error: ${error.message}`));
    await this.queue!.add(
      'daily-plan',
      { messageJobId: '' },
      {
        jobId: 'daily-plan',
        repeat: { pattern: '10 * * * *' },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
    await this.planAllUsers();
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue?.close();
  }

  async configureSchedule(telegramId: bigint, chatId: bigint, action?: string, countRaw?: string) {
    if (action !== 'on' && action !== 'off') {
      await this.conversation.showSchedulerUsage(chatId);
      return;
    }
    const target = Math.min(3, Math.max(1, Number(countRaw ?? 1) || 1));
    const user = await this.prisma.user.update({
      where: { telegramId },
      data: { schedulerEnabled: action === 'on', scheduleDailyTarget: target, lastChatId: chatId },
    });
    if (action === 'off') {
      await this.prisma.messageJob.updateMany({
        where: {
          userId: user.id,
          status: { in: [MessageJobStatus.PLANNED, MessageJobStatus.QUEUED] },
        },
        data: { status: MessageJobStatus.CANCELLED },
      });
      await this.conversation.sendPlainText(chatId, 'Scheduled practice is off.');
      return;
    }
    if (!this.config.schedulerEnabled) {
      await this.conversation.sendPlainText(
        chatId,
        'Schedule preference saved, but the server scheduler is not enabled yet.',
      );
      return;
    }
    await this.planUser(user.id);
    await this.conversation.sendPlainText(
      chatId,
      `Scheduled practice is on: up to ${target} exercise(s) per day.`,
    );
  }

  async configureQuietHours(telegramId: bigint, chatId: bigint, value?: string) {
    if (!value || !/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      await this.conversation.sendPlainText(
        chatId,
        'Usage: /quiet HH:mm-HH:mm, for example /quiet 21:00-08:00',
      );
      return;
    }
    const [start, end] = value.split('-');
    await this.prisma.user.update({
      where: { telegramId },
      data: { quietHoursStart: start, quietHoursEnd: end, lastChatId: chatId },
    });
    await this.conversation.sendPlainText(chatId, `Quiet hours saved: ${start}-${end}.`);
  }

  private async process(job: Job) {
    if (job.name === 'daily-plan') {
      await this.planAllUsers();
      return;
    }
    const data = job.data as PracticeJobData;
    const messageJob = await this.prisma.messageJob.findUnique({
      where: { id: data.messageJobId },
      include: { user: true },
    });
    if (!messageJob || messageJob.status === MessageJobStatus.CANCELLED) return;
    const user = messageJob.user;
    if (!user.schedulerEnabled || !user.lastChatId) {
      await this.finishJob(messageJob.id, MessageJobStatus.SKIPPED);
      return;
    }
    const started = await this.conversation.startPractice({
      telegramId: user.telegramId,
      chatId: user.lastChatId,
      requestedTopic: messageJob.topic,
      source: PracticeSource.SCHEDULED,
      silentIfActive: true,
    });
    await this.finishJob(messageJob.id, started ? MessageJobStatus.SENT : MessageJobStatus.SKIPPED);
  }

  private async planAllUsers() {
    const users = await this.prisma.user.findMany({ where: { schedulerEnabled: true } });
    await Promise.all(users.map((user) => this.planUser(user.id)));
  }

  private async planUser(userId: string) {
    if (!this.queue) return;
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.schedulerEnabled || !user.lastChatId) return;
    const now = DateTime.now().setZone(user.timezone);
    if (!now.isValid) return;
    const dayStart = now.startOf('day');
    const windowStart = dayStart.set({ hour: 9, minute: 0 });
    const windowEnd = dayStart.set({ hour: 20, minute: 0 });
    const earliest = DateTime.max(windowStart, now.plus({ minutes: 10 }));
    if (earliest >= windowEnd) return;
    const rangeMinutes = Math.floor(windowEnd.diff(earliest, 'minutes').minutes);
    const localDate = dayStart.toUTC().toJSDate();
    for (let ordinal = 0; ordinal < user.scheduleDailyTarget; ordinal += 1) {
      const base = Math.floor(((ordinal + 1) * rangeMinutes) / (user.scheduleDailyTarget + 1));
      const jitter = this.jitter(`${user.id}:${dayStart.toISODate()}:${ordinal}`);
      let scheduled = earliest.plus({ minutes: Math.max(0, base + jitter) });
      if (this.isQuiet(scheduled, user.quietHoursStart, user.quietHoursEnd)) {
        scheduled = scheduled.plus({ minutes: 90 });
      }
      if (scheduled > windowEnd) continue;
      const topic = this.topicFor(user.preferredTopics, ordinal);
      const created = await this.prisma.messageJob.upsert({
        where: { userId_localDate_ordinal: { userId: user.id, localDate, ordinal } },
        create: {
          userId: user.id,
          localDate,
          ordinal,
          topic,
          tone: 'polite',
          scheduledAt: scheduled.toUTC().toJSDate(),
          status: MessageJobStatus.PLANNED,
        },
        update: {},
      });
      if (created.status !== MessageJobStatus.PLANNED) continue;
      const jobId = `practice:${created.id}`;
      await this.queue.add(
        'dispatch-practice',
        { messageJobId: created.id },
        {
          jobId,
          delay: Math.max(0, created.scheduledAt.getTime() - Date.now()),
          attempts: 3,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
      await this.prisma.messageJob.update({
        where: { id: created.id },
        data: { status: MessageJobStatus.QUEUED, bullmqJobId: jobId },
      });
    }
  }

  private async finishJob(id: string, status: MessageJobStatus) {
    await this.prisma.messageJob.update({
      where: { id },
      data: { status, attemptCount: { increment: 1 } },
    });
  }

  private topicFor(value: unknown, ordinal: number): Topic {
    const preferred = Array.isArray(value)
      ? value.filter(
          (topic): topic is Topic => typeof topic === 'string' && TOPICS.includes(topic as Topic),
        )
      : [];
    const pool = preferred.length ? preferred : TOPICS;
    return pool[ordinal % pool.length];
  }

  private jitter(seed: string) {
    let hash = 0;
    for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) | 0;
    return (Math.abs(hash) % 61) - 30;
  }

  private isQuiet(time: DateTime, start?: string | null, end?: string | null) {
    if (!start || !end) return false;
    const value = time.toFormat('HH:mm');
    return start < end ? value >= start && value < end : value >= start || value < end;
  }

  private redisConnection(redisUrl: string): ConnectionOptions {
    const url = new URL(redisUrl);
    return {
      host: url.hostname,
      port: Number(url.port || 6379),
      password: url.password || undefined,
      db: Number(url.pathname.replace('/', '') || 0),
      ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
      maxRetriesPerRequest: null,
    };
  }
}
