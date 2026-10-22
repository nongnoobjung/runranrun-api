import { Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AuthGuard, AuthUser, CurrentUser } from '../../common/auth';
import { AdminService } from '../admin/admin.service';
import { RetentionService } from './retention.service';

/** Data retention for platform admins: what the daily job would erase now (dry run), and running it on demand. */
@Controller('admin/retention')
@UseGuards(AuthGuard)
export class RetentionController {
  constructor(
    private readonly admin: AdminService,
    private readonly retention: RetentionService,
  ) {}

  @Get()
  async report(@CurrentUser() user: AuthUser) {
    await this.admin.require(user.id, 'retention');
    return this.retention.report();
  }

  @Post('run')
  @HttpCode(200)
  async run(@CurrentUser() user: AuthUser) {
    await this.admin.require(user.id, 'retention');
    return { counts: await this.retention.run(user.id) };
  }
}
