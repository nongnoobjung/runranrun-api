import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AuthGuard, AuthUser, CurrentUser, RequireAudience } from '../../common/auth';
import { sendFile } from '../../common/upload';
import { parse, uuidSchema } from '../../common/validation';
import { AdminAuditService, auditQuerySchema } from './admin-audit.service';
import { AdminFeesService, feeSchema } from './admin-fees.service';
import { AdminUsersService, userListSchema, userRoleSchema } from './admin-users.service';
import { adminBankSchema, AdminService, docRejectSchema, orgListSchema, orgSettingsSchema, paidSchema, reviewSchema, suspendSchema } from './admin.service';

/** The platform's backoffice; every route checks the caller's platform role. */
@Controller('admin')
@UseGuards(AuthGuard)
@RequireAudience('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly fees: AdminFeesService,
    private readonly audit: AdminAuditService,
    private readonly users: AdminUsersService,
  ) {}

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
    const role = await this.admin.require(user.id, 'view');
    return this.admin.organization(parse(uuidSchema, id), { revealBank: this.admin.allows(role, 'manage_orgs') });
  }

  @Get('organizations/:id/documents/:docId/file')
  async documentFile(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('docId') docId: string, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.admin.require(user.id, 'view');
    return sendFile(reply, await this.admin.documentFile(user.id, parse(uuidSchema, id), parse(uuidSchema, docId)));
  }

  @Post('organizations/:id/documents/:docId/approve')
  @HttpCode(200)
  async approveDocument(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('docId') docId: string) {
    await this.admin.require(user.id, 'manage_orgs');
    return this.admin.reviewDocument(user.id, parse(uuidSchema, id), parse(uuidSchema, docId), { status: 'approved' });
  }

  @Post('organizations/:id/documents/:docId/reject')
  @HttpCode(200)
  async rejectDocument(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('docId') docId: string, @Body() body: unknown) {
    await this.admin.require(user.id, 'manage_orgs');
    const { reason } = parse(docRejectSchema, body);
    return this.admin.reviewDocument(user.id, parse(uuidSchema, id), parse(uuidSchema, docId), { status: 'rejected', reason });
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

  @Post('organizations/:id/bank-account/verify')
  @HttpCode(200)
  async verifyBankAccount(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.require(user.id, 'manage_orgs');
    return this.admin.verifyBankAccount(user.id, parse(uuidSchema, id));
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

  @Get('platform-fees')
  async platformFees(@CurrentUser() user: AuthUser) {
    await this.admin.require(user.id, 'fees');
    return this.fees.list();
  }

  @Put('platform-fees/default')
  async setDefaultFee(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    await this.admin.require(user.id, 'fees');
    return this.fees.set(user.id, null, parse(feeSchema, body));
  }

  @Put('organizations/:id/platform-fee')
  async setOrganizationFee(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    await this.admin.require(user.id, 'fees');
    return this.fees.set(user.id, parse(uuidSchema, id), parse(feeSchema, body));
  }

  @Delete('organizations/:id/platform-fee')
  async clearOrganizationFee(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.require(user.id, 'fees');
    return this.fees.clear(user.id, parse(uuidSchema, id));
  }

  @Get('audit')
  async auditLog(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    await this.admin.require(user.id, 'view');
    return this.audit.list(parse(auditQuerySchema, query));
  }

  @Get('audit/:id')
  async auditEntry(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.require(user.id, 'view');
    return this.audit.get(parse(z.coerce.number().int().positive(), id));
  }

  @Get('users')
  async userList(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    await this.admin.require(user.id, 'view');
    return this.users.list(parse(userListSchema, query));
  }

  @Get('users/:id')
  async userDetail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.require(user.id, 'view');
    return this.users.get(user.id, parse(uuidSchema, id));
  }

  @Post('users/:id/suspend')
  @HttpCode(200)
  async suspendUser(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const role = await this.admin.require(user.id, 'manage_users');
    return this.users.suspend(user.id, role, parse(uuidSchema, id), parse(suspendSchema, body).reason);
  }

  @Post('users/:id/reactivate')
  @HttpCode(200)
  async reactivateUser(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const role = await this.admin.require(user.id, 'manage_users');
    return this.users.reactivate(user.id, role, parse(uuidSchema, id));
  }

  @Put('users/:id/platform-role')
  async setUserRole(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    await this.admin.require(user.id, 'manage_roles');
    return this.users.setRole(user.id, parse(uuidSchema, id), parse(userRoleSchema, body).role);
  }
}
