import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, AuthUser, CurrentUser } from '../../common/auth';
import { parse, uuidSchema } from '../../common/validation';
import { adminBankSchema, AdminService, orgListSchema, orgSettingsSchema, paidSchema, reviewSchema, suspendSchema } from './admin.service';

/** The platform's backoffice; every route checks the caller's platform role. */
@Controller('admin')
@UseGuards(AuthGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.admin.me(user.id);
  }

  @Get('overview')
  async overview(@CurrentUser() user: AuthUser) {
    await this.admin.require(user.id, 'view');
    return this.admin.overview();
  }

  @Get('reviews')
  async reviews(@CurrentUser() user: AuthUser) {
    await this.admin.require(user.id, 'view');
    return this.admin.reviewQueue();
  }

  @Get('events/:id')
  async event(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.require(user.id, 'view');
    return this.admin.event(parse(uuidSchema, id));
  }

  @Post('events/:id/approve')
  @HttpCode(200)
  async approveEvent(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.require(user.id, 'review_events');
    return this.admin.approveEvent(user.id, parse(uuidSchema, id));
  }

  @Post('events/:id/reject')
  @HttpCode(200)
  async rejectEvent(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    await this.admin.require(user.id, 'review_events');
    return this.admin.rejectEvent(user.id, parse(uuidSchema, id), parse(reviewSchema, body).note);
  }

  @Get('organizations')
  async organizations(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    await this.admin.require(user.id, 'view');
    return this.admin.organizations(parse(orgListSchema, query).status);
  }

  @Get('organizations/:id')
  async organization(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.require(user.id, 'view');
    return this.admin.organization(parse(uuidSchema, id));
  }

  @Post('organizations/:id/approve')
  @HttpCode(200)
  async approveOrganization(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.require(user.id, 'manage_orgs');
    return this.admin.approveOrganization(user.id, parse(uuidSchema, id));
  }

  @Post('organizations/:id/suspend')
  @HttpCode(200)
  async suspendOrganization(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    await this.admin.require(user.id, 'manage_orgs');
    return this.admin.suspendOrganization(user.id, parse(uuidSchema, id), parse(suspendSchema, body).reason);
  }

  @Post('organizations/:id/reactivate')
  @HttpCode(200)
  async reactivateOrganization(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.require(user.id, 'manage_orgs');
    return this.admin.reactivateOrganization(user.id, parse(uuidSchema, id));
  }

  @Patch('organizations/:id')
  async updateOrganization(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    await this.admin.require(user.id, 'manage_orgs');
    return this.admin.updateOrganization(user.id, parse(uuidSchema, id), parse(orgSettingsSchema, body));
  }

  @Put('organizations/:id/bank-account')
  async setBankAccount(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    await this.admin.require(user.id, 'manage_orgs');
    return this.admin.setBankAccount(user.id, parse(uuidSchema, id), parse(adminBankSchema, body));
  }

  @Get('payouts')
  async payouts(@CurrentUser() user: AuthUser) {
    await this.admin.require(user.id, 'payouts');
    return this.admin.payouts();
  }

  @Post('events/:id/settlements')
  async createSettlement(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.require(user.id, 'payouts');
    return this.admin.createSettlement(user.id, parse(uuidSchema, id));
  }

  @Post('settlements/:id/approve')
  @HttpCode(200)
  async approveSettlement(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.require(user.id, 'payouts');
    return this.admin.approveSettlement(user.id, parse(uuidSchema, id));
  }

  @Post('settlements/:id/paid')
  @HttpCode(200)
  async markPaid(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    await this.admin.require(user.id, 'payouts');
    return this.admin.markPaid(user.id, parse(uuidSchema, id), parse(paidSchema, body).transferRef);
  }

  @Post('settlements/:id/void')
  @HttpCode(200)
  async voidSettlement(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.require(user.id, 'payouts');
    return this.admin.voidSettlement(user.id, parse(uuidSchema, id));
  }
}
