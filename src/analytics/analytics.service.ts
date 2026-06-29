import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { PrismaService } from '../persistence/prisma.service';

export interface PracticeStats {
  completedCount: number;
  averageScore: number | null;
  sevenDayAverage: number | null;
  streakDays: number;
  categoryCounts: Record<'grammar' | 'tone' | 'clarity' | 'missing', number>;
  recentScores: Array<{ date: string; score: number }>;
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getStats(userId: string, timezone: string): Promise<PracticeStats> {
    const sessions = await this.prisma.practiceSession.findMany({
      where: { userId, status: 'COMPLETED' },
      include: { evaluation: true },
      orderBy: { completedAt: 'desc' },
      take: 100,
    });
    const evaluated = sessions.filter((session) => session.evaluation && session.completedAt);
    const scores = evaluated.map((session) => Number(session.evaluation!.overallScore));
    const sevenDaysAgo = DateTime.now().setZone(timezone).startOf('day').minus({ days: 6 });
    const lastSevenScores = evaluated
      .filter(
        (session) => DateTime.fromJSDate(session.completedAt!).setZone(timezone) >= sevenDaysAgo,
      )
      .map((session) => Number(session.evaluation!.overallScore));
    const categoryCounts = { grammar: 0, tone: 0, clarity: 0, missing: 0 };
    for (const session of evaluated) {
      const feedback = session.evaluation!.feedback as Record<string, unknown>;
      if (Array.isArray(feedback.grammarFeedback) && feedback.grammarFeedback.length)
        categoryCounts.grammar += 1;
      if (Array.isArray(feedback.toneFeedback) && feedback.toneFeedback.length)
        categoryCounts.tone += 1;
      if (Array.isArray(feedback.clarityFeedback) && feedback.clarityFeedback.length)
        categoryCounts.clarity += 1;
      if (Array.isArray(feedback.missingInformation) && feedback.missingInformation.length)
        categoryCounts.missing += 1;
    }
    return {
      completedCount: evaluated.length,
      averageScore: this.average(scores),
      sevenDayAverage: this.average(lastSevenScores),
      streakDays: this.streak(
        evaluated.map((session) => session.completedAt!),
        timezone,
      ),
      categoryCounts,
      recentScores: evaluated
        .slice(0, 7)
        .reverse()
        .map((session) => ({
          date: DateTime.fromJSDate(session.completedAt!).setZone(timezone).toFormat('LLL d'),
          score: Number(session.evaluation!.overallScore),
        })),
    };
  }

  private average(values: number[]) {
    if (!values.length) return null;
    return Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(1));
  }

  private streak(dates: Date[], timezone: string) {
    const completedDates = new Set(
      dates.map((date) => DateTime.fromJSDate(date).setZone(timezone).toISODate()),
    );
    let day = DateTime.now().setZone(timezone).startOf('day');
    if (!completedDates.has(day.toISODate())) day = day.minus({ days: 1 });
    let streak = 0;
    while (completedDates.has(day.toISODate())) {
      streak += 1;
      day = day.minus({ days: 1 });
    }
    return streak;
  }
}
