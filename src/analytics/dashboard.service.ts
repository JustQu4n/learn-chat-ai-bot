import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppConfig } from '../config/app-config.service';
import { PrismaService } from '../persistence/prisma.service';
import { AnalyticsService, PracticeStats } from './analytics.service';

@Injectable()
export class DashboardService {
  constructor(
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
  ) {}

  async createLink(userId: string) {
    if (!this.config.publicBaseUrl) return null;
    const payload = Buffer.from(
      JSON.stringify({ userId, expiresAt: Date.now() + 15 * 60 * 1000 }),
    ).toString('base64url');
    return `${this.config.publicBaseUrl}/dashboard?token=${payload}.${this.sign(payload)}`;
  }

  async render(token: string) {
    const { userId } = this.verify(token);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    const stats = await this.analytics.getStats(user.id, user.timezone);
    return this.html(stats);
  }

  private verify(token: string): { userId: string; expiresAt: number } {
    const [payload, signature] = token.split('.');
    if (!payload || !signature || !this.sameSignature(signature, this.sign(payload))) {
      throw new UnauthorizedException();
    }
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      userId?: string;
      expiresAt?: number;
    };
    if (!decoded.userId || !decoded.expiresAt || decoded.expiresAt < Date.now()) {
      throw new UnauthorizedException();
    }
    return { userId: decoded.userId, expiresAt: decoded.expiresAt };
  }

  private sign(payload: string) {
    return createHmac('sha256', this.config.dashboardSigningSecret)
      .update(payload)
      .digest('base64url');
  }

  private sameSignature(received: string, expected: string) {
    const left = Buffer.from(received);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  private html(stats: PracticeStats) {
    const count = stats.categoryCounts;
    const trend = stats.recentScores.length
      ? stats.recentScores
          .map((item) => `<li>${item.date}: <strong>${item.score}/10</strong></li>`)
          .join('')
      : '<li>No completed exercises yet.</li>';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>English Practice Dashboard</title><style>body{margin:0;background:#101827;color:#eef2ff;font:16px system-ui;padding:28px}.wrap{max-width:760px;margin:auto}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.card{background:#1e293b;border-radius:14px;padding:16px}.value{font-size:28px;font-weight:700;color:#67e8f9}h1{margin-top:0}h2{font-size:18px}ul{padding-left:20px;line-height:1.7}</style></head><body><main class="wrap"><h1>English Practice</h1><div class="grid"><section class="card"><div>Completed</div><div class="value">${stats.completedCount}</div></section><section class="card"><div>Average score</div><div class="value">${stats.averageScore ?? '—'}</div></section><section class="card"><div>Last 7 days</div><div class="value">${stats.sevenDayAverage ?? '—'}</div></section><section class="card"><div>Streak</div><div class="value">${stats.streakDays} days</div></section></div><section class="card"><h2>Common improvement areas</h2><p>Grammar ${count.grammar} · Tone ${count.tone} · Clarity ${count.clarity} · Missing details ${count.missing}</p></section><section class="card"><h2>Recent scores</h2><ul>${trend}</ul></section></main></body></html>`;
  }
}
