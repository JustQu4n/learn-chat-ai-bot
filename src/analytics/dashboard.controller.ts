import { Controller, Get, Header, Query } from '@nestjs/common';
import { DashboardService } from './dashboard.service';

@Controller()
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('dashboard')
  @Header('content-type', 'text/html; charset=utf-8')
  async show(@Query('token') token?: string) {
    return this.dashboard.render(token ?? '');
  }
}
