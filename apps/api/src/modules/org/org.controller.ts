import { Body, Controller, Delete, Get, Header, HttpCode, Param, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { AuthGuard, AuthUser, CurrentUser } from '../../common/auth';
import { parse, uuidSchema } from '../../common/validation';
import { DbService } from '../../db/db.service';
import { cancelSchema, refundListSchema, RefundsService, rejectSchema, transferredSchema } from '../refunds/refunds.service';
import { WaitlistService } from '../waitlist/waitlist.service';
import { OrgAccessService } from './org-access.service';
import { OrgFinanceService, transactionsQuerySchema } from './org-finance.service';
import { OrgResultsService, publishSchema, resultsImportSchema } from './org-results.service';
import { assignSchema, importSchema, OrgBibsService, setBibSchema } from './org-bibs.service';
import { couponFieldsSchema, createCouponSchema, OrgCouponsService } from './org-coupons.service';
import {
  createEventSchema,
  eventFieldsSchema,
  OrgEventsService,
  raceFieldsSchema,
  shirtsSchema,
  tierFieldsSchema,
} from './org-events.service';
import { inviteSchema, memberRoleSchema, OrgMembersService } from './org-members.service';
import { createQuestionSchema, OrgQuestionsService, questionFieldsSchema, reorderSchema } from './org-questions.service';
import { checkinSchema, listQuerySchema, OrgRegistrationsService } from './org-registrations.service';

const raceCreateSchema = raceFieldsSchema.partial().required({ code: true, nameTh: true, distanceKm: true, capacity: true }).transform((r) => ({
  startAt: null, cutoffMinutes: null, ageMin: null, bibPrefix: null, bibStart: null, bibEnd: null, ...r,
}));
const tierCreateSchema = tierFieldsSchema.partial().required({ name: true, priceSatang: true, startsAt: true, endsAt: true }).transform((t) => ({
  quota: null, ...t,
}));

/** Organizer backoffice. Every route checks the caller's role in the organisation in the URL. */
@Controller('org')
@UseGuards(AuthGuard)
export class OrgController {
  constructor(
    private readonly dbs: DbService,
    private readonly access: OrgAccessService,
    private readonly events: OrgEventsService,
    private readonly coupons: OrgCouponsService,
    private readonly registrations: OrgRegistrationsService,
    private readonly members: OrgMembersService,
    private readonly waitlist: WaitlistService,
    private readonly results: OrgResultsService,
    private readonly refunds: RefundsService,
    private readonly finance: OrgFinanceService,
    private readonly questions: OrgQuestionsService,
    private readonly bibs: OrgBibsService,
  ) {}

  /**
   * Organisations the caller belongs to. The web app shows the backoffice link when this is not empty.
   * Open invitations for the caller's email are accepted here, so an invited person joins on first visit.
   */
  @Get()
  async mine(@CurrentUser() user: AuthUser) {
    await this.members.acceptInvites(user.id);
    const { rows } = await this.dbs.pool.query(
      `SELECT o.id, o.slug, o.name_th, o.status, m.role
         FROM org_members m JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = $1 AND m.accepted_at IS NOT NULL
        ORDER BY o.name_th`,
      [user.id],
    );
    return { items: rows.map((r) => ({ id: r.id, slug: r.slug, nameTh: r.name_th, status: r.status, role: r.role })) };
  }

  @Get(':orgId/members')
  async listMembers(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string) {
    const m = await this.access.require(user.id, parse(uuidSchema, orgId), 'view');
    return this.members.list(m.organizationId, user.id);
  }

  @Post(':orgId/members')
  async inviteMember(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Body() body: unknown) {
    const m = await this.access.require(user.id, parse(uuidSchema, orgId), 'manage_team');
    return this.members.invite(user.id, m.organizationId, parse(inviteSchema, body));
  }

  @Patch(':orgId/members/:memberId')
  async changeMemberRole(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('memberId') memberId: string, @Body() body: unknown) {
    const m = await this.access.require(user.id, parse(uuidSchema, orgId), 'manage_team');
    return this.members.changeRole(user.id, m.organizationId, parse(uuidSchema, memberId), parse(memberRoleSchema, body).role);
  }

  @Delete(':orgId/members/:memberId')
  async removeMember(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('memberId') memberId: string) {
    const m = await this.access.require(user.id, parse(uuidSchema, orgId), 'manage_team');
    return this.members.remove(user.id, m.organizationId, parse(uuidSchema, memberId));
  }

  @Get(':orgId/finance')
  async orgFinance(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string) {
    const m = await this.access.require(user.id, parse(uuidSchema, orgId), 'view_finance');
    return this.finance.orgSummary(m.organizationId);
  }

  @Get(':orgId/events/:eventId/finance')
  async eventFinance(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string) {
    const e = await this.eventAccess(user, orgId, eventId, 'view_finance');
    return this.finance.eventSummary(e.organizationId, e.eventId);
  }

  @Get(':orgId/events/:eventId/finance/transactions')
  async transactions(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string, @Query() query: unknown) {
    const e = await this.eventAccess(user, orgId, eventId, 'view_finance');
    return this.finance.transactions(e.organizationId, e.eventId, parse(transactionsQuerySchema, query));
  }

  @Get(':orgId/events/:eventId/finance/transactions.csv')
  @Header('content-type', 'text/csv; charset=utf-8')
  async transactionsCsv(
    @CurrentUser() user: AuthUser,
    @Param('orgId') orgId: string,
    @Param('eventId') eventId: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const e = await this.eventAccess(user, orgId, eventId, 'view_finance');
    const { status } = parse(transactionsQuerySchema, query);
    void reply.header('content-disposition', `attachment; filename="transactions-${e.eventId.slice(0, 8)}.csv"`);
    return this.finance.transactionsCsv(user.id, e.organizationId, e.eventId, status);
  }

  @Get(':orgId/events')
  async listEvents(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string) {
    const m = await this.access.require(user.id, parse(uuidSchema, orgId), 'view');
    return this.events.list(m.organizationId);
  }

  @Post(':orgId/events')
  async createEvent(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Body() body: unknown) {
    const m = await this.access.require(user.id, parse(uuidSchema, orgId), 'manage_event');
    return this.events.create(user.id, m.organizationId, parse(createEventSchema, body));
  }

  @Get(':orgId/events/:eventId')
  async getEvent(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string) {
    const e = await this.eventAccess(user, orgId, eventId, 'view');
    return this.events.get(e.organizationId, e.eventId);
  }

  @Patch(':orgId/events/:eventId')
  async updateEvent(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string, @Body() body: unknown) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_event');
    return this.events.update(user.id, e.organizationId, e.eventId, parse(eventFieldsSchema.partial(), body));
  }

  @Post(':orgId/events/:eventId/publish')
  async publish(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_event');
    return this.events.publish(user.id, e.organizationId, e.eventId);
  }

  @Post(':orgId/events/:eventId/close')
  async close(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_event');
    return this.events.close(user.id, e.organizationId, e.eventId);
  }

  @Get(':orgId/events/:eventId/dashboard')
  async dashboard(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string) {
    const e = await this.eventAccess(user, orgId, eventId, 'view');
    return this.events.dashboard(e.eventId);
  }

  @Post(':orgId/events/:eventId/races')
  async createRace(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string, @Body() body: unknown) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_event');
    return this.events.createRace(user.id, e.organizationId, e.eventId, parse(raceCreateSchema, body));
  }

  @Patch(':orgId/events/:eventId/races/:raceId')
  async updateRace(
    @CurrentUser() user: AuthUser,
    @Param('orgId') orgId: string,
    @Param('eventId') eventId: string,
    @Param('raceId') raceId: string,
    @Body() body: unknown,
  ) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_event');
    return this.events.updateRace(user.id, e.organizationId, e.eventId, parse(uuidSchema, raceId), parse(raceFieldsSchema.partial(), body));
  }

  @Delete(':orgId/events/:eventId/races/:raceId')
  async deleteRace(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string, @Param('raceId') raceId: string) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_event');
    return this.events.deleteRace(user.id, e.organizationId, e.eventId, parse(uuidSchema, raceId));
  }

  @Post(':orgId/events/:eventId/races/:raceId/price-tiers')
  async createTier(
    @CurrentUser() user: AuthUser,
    @Param('orgId') orgId: string,
    @Param('eventId') eventId: string,
    @Param('raceId') raceId: string,
    @Body() body: unknown,
  ) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_event');
    return this.events.createTier(user.id, e.organizationId, e.eventId, parse(uuidSchema, raceId), parse(tierCreateSchema, body));
  }

  @Patch(':orgId/events/:eventId/races/:raceId/price-tiers/:tierId')
  async updateTier(
    @CurrentUser() user: AuthUser,
    @Param('orgId') orgId: string,
    @Param('eventId') eventId: string,
    @Param('raceId') raceId: string,
    @Param('tierId') tierId: string,
    @Body() body: unknown,
  ) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_event');
    return this.events.updateTier(
      user.id, e.organizationId, e.eventId, parse(uuidSchema, raceId), parse(uuidSchema, tierId), parse(tierFieldsSchema.partial(), body),
    );
  }

  @Delete(':orgId/events/:eventId/races/:raceId/price-tiers/:tierId')
  async deleteTier(
    @CurrentUser() user: AuthUser,
    @Param('orgId') orgId: string,
    @Param('eventId') eventId: string,
    @Param('raceId') raceId: string,
    @Param('tierId') tierId: string,
  ) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_event');
    return this.events.deleteTier(user.id, e.organizationId, e.eventId, parse(uuidSchema, raceId), parse(uuidSchema, tierId));
  }

  @Put(':orgId/events/:eventId/shirts')
  async setShirts(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string, @Body() body: unknown) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_event');
    return this.events.setShirts(user.id, e.organizationId, e.eventId, parse(shirtsSchema, body));
  }

  @Get(':orgId/events/:eventId/coupons')
  async listCoupons(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string) {
    const e = await this.eventAccess(user, orgId, eventId, 'view');
    return this.coupons.list(e.eventId);
  }

  @Post(':orgId/events/:eventId/coupons')
  async createCoupon(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string, @Body() body: unknown) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_event');
    return this.coupons.create(user.id, e.organizationId, e.eventId, parse(createCouponSchema, body));
  }

  @Patch(':orgId/events/:eventId/coupons/:couponId')
  async updateCoupon(
    @CurrentUser() user: AuthUser,
    @Param('orgId') orgId: string,
    @Param('eventId') eventId: string,
    @Param('couponId') couponId: string,
    @Body() body: unknown,
  ) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_event');
    return this.coupons.update(user.id, e.organizationId, e.eventId, parse(uuidSchema, couponId), parse(couponFieldsSchema.partial(), body));
  }

  @Get(':orgId/events/:eventId/questions')
  async listQuestions(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string) {
    const e = await this.eventAccess(user, orgId, eventId, 'view');
    return this.questions.list(e.eventId);
  }

  @Post(':orgId/events/:eventId/questions')
  async createQuestion(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string, @Body() body: unknown) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_event');
    return this.questions.create(user.id, e.organizationId, e.eventId, parse(createQuestionSchema, body));
  }

  @Put(':orgId/events/:eventId/questions/order')
  async reorderQuestions(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string, @Body() body: unknown) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_event');
    return this.questions.reorder(user.id, e.organizationId, e.eventId, parse(reorderSchema, body).ids);
  }

  @Patch(':orgId/events/:eventId/questions/:questionId')
  async updateQuestion(
    @CurrentUser() user: AuthUser,
    @Param('orgId') orgId: string,
    @Param('eventId') eventId: string,
    @Param('questionId') questionId: string,
    @Body() body: unknown,
  ) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_event');
    return this.questions.update(user.id, e.organizationId, e.eventId, parse(uuidSchema, questionId), parse(questionFieldsSchema.partial(), body));
  }

  @Delete(':orgId/events/:eventId/questions/:questionId')
  async deleteQuestion(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string, @Param('questionId') questionId: string) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_event');
    return this.questions.remove(user.id, e.organizationId, e.eventId, parse(uuidSchema, questionId));
  }

  @Get(':orgId/events/:eventId/bibs')
  async bibOverview(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string) {
    const e = await this.eventAccess(user, orgId, eventId, 'view');
    return this.bibs.overview(e.eventId);
  }

  @Post(':orgId/events/:eventId/bibs/assign')
  async assignBibs(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string, @Body() body: unknown) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_event');
    return this.bibs.assignWaiting(user.id, e.organizationId, e.eventId, parse(assignSchema, body ?? {}).raceId);
  }

  @Post(':orgId/events/:eventId/bibs/import')
  @HttpCode(200)
  async importBibs(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string, @Body() body: unknown) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_event');
    const input = parse(importSchema, body);
    return this.bibs.import(user.id, e.organizationId, e.eventId, input.csv, input.dryRun);
  }

  @Put(':orgId/events/:eventId/registrations/:registrationId/bib')
  async setBib(
    @CurrentUser() user: AuthUser,
    @Param('orgId') orgId: string,
    @Param('eventId') eventId: string,
    @Param('registrationId') registrationId: string,
    @Body() body: unknown,
  ) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_event');
    return this.bibs.set(user.id, e.organizationId, e.eventId, parse(uuidSchema, registrationId), parse(setBibSchema, body).bibNumber);
  }

  @Get(':orgId/events/:eventId/refunds')
  async listRefunds(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string, @Query() query: unknown) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_refunds');
    return this.refunds.list(e.eventId, parse(refundListSchema, query).status);
  }

  @Post(':orgId/events/:eventId/refunds/:refundId/approve')
  async approveRefund(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string, @Param('refundId') refundId: string) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_refunds');
    return this.refunds.approve(user.id, e.organizationId, e.eventId, parse(uuidSchema, refundId));
  }

  @Post(':orgId/events/:eventId/refunds/:refundId/reject')
  async rejectRefund(
    @CurrentUser() user: AuthUser,
    @Param('orgId') orgId: string,
    @Param('eventId') eventId: string,
    @Param('refundId') refundId: string,
    @Body() body: unknown,
  ) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_refunds');
    return this.refunds.reject(user.id, e.organizationId, e.eventId, parse(uuidSchema, refundId), parse(rejectSchema, body).note);
  }

  @Post(':orgId/events/:eventId/refunds/:refundId/transferred')
  async refundTransferred(
    @CurrentUser() user: AuthUser,
    @Param('orgId') orgId: string,
    @Param('eventId') eventId: string,
    @Param('refundId') refundId: string,
    @Body() body: unknown,
  ) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_refunds');
    return this.refunds.markTransferred(user.id, e.organizationId, e.eventId, parse(uuidSchema, refundId), parse(transferredSchema, body).reference);
  }

  @Post(':orgId/events/:eventId/registrations/:registrationId/cancel')
  async cancelRegistration(
    @CurrentUser() user: AuthUser,
    @Param('orgId') orgId: string,
    @Param('eventId') eventId: string,
    @Param('registrationId') registrationId: string,
    @Body() body: unknown,
  ) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_refunds');
    return this.refunds.cancelRegistration(user.id, e.organizationId, e.eventId, parse(uuidSchema, registrationId), parse(cancelSchema, body));
  }

  @Get(':orgId/events/:eventId/results')
  async resultsSummary(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string) {
    const e = await this.eventAccess(user, orgId, eventId, 'view');
    return this.results.summary(e.eventId);
  }

  @Post(':orgId/events/:eventId/results/import')
  @HttpCode(200)
  async importResults(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string, @Body() body: unknown) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_event');
    const input = parse(resultsImportSchema, body);
    return this.results.import(user.id, e.organizationId, e.eventId, input.csv, input.dryRun);
  }

  @Post(':orgId/events/:eventId/results/publish')
  @HttpCode(200)
  async publishResults(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string, @Body() body: unknown) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_event');
    return this.results.publish(user.id, e.organizationId, e.eventId, parse(publishSchema, body).published);
  }

  @Get(':orgId/events/:eventId/waitlist')
  async eventWaitlist(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string) {
    const e = await this.eventAccess(user, orgId, eventId, 'view');
    return this.waitlist.forEvent(e.eventId);
  }

  /** Offers the event's free places to its queues now instead of at the next 30-second run. */
  @Post(':orgId/events/:eventId/waitlist/offer')
  @HttpCode(200)
  async offerWaitlist(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string) {
    const e = await this.eventAccess(user, orgId, eventId, 'manage_event');
    const { rows } = await this.dbs.pool.query<{ id: string }>('SELECT id FROM races WHERE event_id = $1 AND is_active', [e.eventId]);
    let offered = 0;
    for (const r of rows) offered += await this.waitlist.offerFreed(r.id);
    return { offered, ...(await this.waitlist.forEvent(e.eventId)) };
  }

  @Get(':orgId/events/:eventId/registrations')
  async listRegistrations(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string, @Query() query: unknown) {
    const e = await this.eventAccess(user, orgId, eventId, 'view');
    return this.registrations.list(e.eventId, parse(listQuerySchema, query));
  }

  @Get(':orgId/events/:eventId/registrations.csv')
  @Header('content-type', 'text/csv; charset=utf-8')
  async exportRegistrations(
    @CurrentUser() user: AuthUser,
    @Param('orgId') orgId: string,
    @Param('eventId') eventId: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const e = await this.eventAccess(user, orgId, eventId, 'view_pii');
    const { limit: _limit, offset: _offset, ...filters } = parse(listQuerySchema, query);
    void reply.header('content-disposition', `attachment; filename="registrations-${e.eventId.slice(0, 8)}.csv"`);
    return this.registrations.exportCsv(user.id, e.organizationId, e.eventId, filters);
  }

  @Get(':orgId/registrations/:registrationId')
  async getRegistration(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('registrationId') registrationId: string) {
    const m = await this.access.require(user.id, parse(uuidSchema, orgId), 'view');
    return this.registrations.get(m.organizationId, parse(uuidSchema, registrationId));
  }

  @Post(':orgId/registrations/:registrationId/reveal-id-doc')
  async revealIdDoc(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('registrationId') registrationId: string) {
    const m = await this.access.require(user.id, parse(uuidSchema, orgId), 'view_pii');
    return this.registrations.revealIdDoc(user.id, m.organizationId, parse(uuidSchema, registrationId));
  }

  @Get(':orgId/events/:eventId/checkins/lookup')
  async lookup(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string, @Query('code') code: unknown) {
    const e = await this.eventAccess(user, orgId, eventId, 'checkin');
    return this.registrations.lookup(e.eventId, parse(checkinSchema.shape.code, code));
  }

  @Post(':orgId/events/:eventId/checkins')
  async checkin(@CurrentUser() user: AuthUser, @Param('orgId') orgId: string, @Param('eventId') eventId: string, @Body() body: unknown) {
    const e = await this.eventAccess(user, orgId, eventId, 'checkin');
    return this.registrations.checkin(user.id, e.organizationId, e.eventId, parse(checkinSchema, body));
  }

  private eventAccess(user: AuthUser, orgId: string, eventId: string, permission: Parameters<OrgAccessService['require']>[2]) {
    return this.access.requireEvent(user.id, parse(uuidSchema, orgId), parse(uuidSchema, eventId), permission);
  }
}
