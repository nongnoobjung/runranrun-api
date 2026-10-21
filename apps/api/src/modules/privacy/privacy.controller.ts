import { Body, Controller, Delete, Get, Post, Req, UseGuards } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { AuthGuard, AuthUser, CurrentUser } from '../../common/auth';
import { RateLimitService } from '../../common/rate-limit';
import { parse } from '../../common/validation';
import { consentChangeSchema, deleteAccountSchema, PrivacyService } from './privacy.service';

/** The account holder's PDPA rights: their consents, a copy of their data, and closing the account. */
@Controller('me')
@UseGuards(AuthGuard)
export class PrivacyController {
  constructor(
    private readonly privacy: PrivacyService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get('consents')
  consents(@CurrentUser() user: AuthUser) {
    return this.privacy.consents(user.id);
  }

  @Post('consents')
  changeConsent(@CurrentUser() user: AuthUser, @Body() body: unknown, @Req() req: FastifyRequest) {
    return this.privacy.changeConsent(user.id, parse(consentChangeSchema, body), { ip: this.rateLimit.clientIp(req), userAgent: req.headers['user-agent'] ?? null });
  }

  @Get('data')
  data(@CurrentUser() user: AuthUser) {
    return this.privacy.export(user.id);
  }

  @Delete()
  deleteAccount(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    parse(deleteAccountSchema, body);
    return this.privacy.deleteAccount(user.id);
  }
}
