import { Global, Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Global()
@Module({
  controllers: [DashboardController],
  providers: [AnalyticsService, DashboardService],
  exports: [AnalyticsService, DashboardService],
})
export class AnalyticsModule {}
