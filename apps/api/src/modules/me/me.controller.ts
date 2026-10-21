import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, AuthUser, CurrentUser } from '../../common/auth';
import { problems } from '../../common/problem';
import { parse, uuidSchema } from '../../common/validation';
import { DbService } from '../../db/db.service';
import { acceptTransferSchema, ChangesService, raceChangeSchema, transferRequestSchema } from '../changes/changes.service';
import { refundRequestSchema, RefundsService } from '../refunds/refunds.service';
import { profileSchema, ProfilesService, profileUpdateSchema } from '../profiles/profiles.service';
import { WaitlistService } from '../waitlist/waitlist.service';

const REGISTRATION_SQL = `
  SELECT r.id, r.registration_no, r.status, r.bib_number, r.qr_token, r.shirt_size, r.first_name_en, r.last_name_en,
         r.first_name_th, r.last_name_th, r.kit_picked_up_at, r.age_on_race_day,
         ra.code AS race_code, ra.distance_km, ra.start_at, ra.cutoff_minutes,
         e.slug AS event_slug, e.name_th AS event_name, e.event_date::text AS event_date, e.venue_name, e.cover_image_url,
         o.order_no, ag.code AS age_group
    FROM registrations r
    JOIN races ra ON ra.id = r.race_id
    JOIN events e ON e.id = r.event_id
    LEFT JOIN orders o ON o.id = r.order_id
    LEFT JOIN age_groups ag ON ag.id = r.age_group_id
   WHERE (r.runner_user_id = $1 OR (o.buyer_user_id = $1 AND r.transferred_from_id IS NULL))
     AND r.status IN ('pending', 'confirmed')`;

@Controller('me')
@UseGuards(AuthGuard)
export class MeController {
  constructor(
    private readonly dbs: DbService,
    private readonly refunds: RefundsService,
    private readonly waitlist: WaitlistService,
    private readonly changes: ChangesService,
    private readonly profiles: ProfilesService,
  ) {}

  @Get('registrations')
  async registrations(@CurrentUser() user: AuthUser) {
    const { rows } = await this.dbs.pool.query(`${REGISTRATION_SQL} ORDER BY e.event_date, r.registration_no`, [user.id]);
    return { items: rows.map(view) };
  }

  @Get('registrations/:id')
  async registration(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const { rows } = await this.dbs.pool.query(`${REGISTRATION_SQL} AND r.id = $2`, [user.id, parse(uuidSchema, id)]);
    if (!rows[0]) throw problems.notFound('Registration');
    return view(rows[0]);
  }

  /** The refund the runner would get today, or why they cannot ask, plus their latest request. */
  @Get('registrations/:id/refund')
  async refundQuote(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.refunds.quote(user.id, parse(uuidSchema, id));
  }

  /** Saved runners to register again without retyping; ID numbers come back as the last four digits only. */
  @Get('profiles')
  async myProfiles(@CurrentUser() user: AuthUser) {
    return this.profiles.list(user.id);
  }

  @Post('profiles')
  async createProfile(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.profiles.create(user.id, parse(profileSchema, body));
  }

  @Patch('profiles/:id')
  async updateProfile(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.profiles.update(user.id, parse(uuidSchema, id), parse(profileUpdateSchema, body));
  }

  @Delete('profiles/:id')
  async deleteProfile(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.profiles.remove(user.id, parse(uuidSchema, id));
  }

  @Get('waitlist')
  async myWaitlist(@CurrentUser() user: AuthUser) {
    return this.waitlist.mine(user.id);
  }

  /** Queue for a full race. */
  @Post('waitlist')
  async joinWaitlist(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.waitlist.join(user.id, parse(z.object({ raceId: z.string().uuid() }), body).raceId);
  }

  @Delete('waitlist/:id')
  async leaveWaitlist(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.waitlist.leave(user.id, parse(uuidSchema, id));
  }

  /** Takes up an offered place: returns the checkout to fill in and pay. */
  @Post('waitlist/:id/claim')
  async claimWaitlist(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.waitlist.claim(user.id, parse(uuidSchema, id));
  }

  /** Whether the place can be transferred or moved to another race, the open one if any, and the races to move to. */
  @Get('registrations/:id/changes')
  async changeOptions(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.changes.options(user.id, parse(uuidSchema, id));
  }

  /** Offers the place to someone else by email. */
  @Post('registrations/:id/transfers')
  async createTransfer(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.changes.createTransfer(user.id, parse(uuidSchema, id), parse(transferRequestSchema, body).toEmail);
  }

  @Post('registrations/:id/race-changes')
  async requestRaceChange(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.changes.requestRaceChange(user.id, parse(uuidSchema, id), parse(raceChangeSchema, body).toRaceId);
  }

  @Delete('race-changes/:id')
  async cancelRaceChange(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.changes.cancelRaceChange(user.id, parse(uuidSchema, id));
  }

  /** Transfers offered to the user's email, and the ones they sent. */
  @Get('transfers')
  async transfers(@CurrentUser() user: AuthUser) {
    return this.changes.mine(user.id);
  }

  /** The sender takes the offer back. */
  @Delete('transfers/:id')
  async cancelTransfer(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.changes.cancelTransfer(user.id, parse(uuidSchema, id));
  }

  /** The recipient takes the place with their own runner details (and pays the fee, if any). */
  @Post('transfers/:id/accept')
  async acceptTransfer(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.changes.acceptTransfer(user.id, parse(uuidSchema, id), parse(acceptTransferSchema, body));
  }

  @Post('transfers/:id/decline')
  async declineTransfer(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.changes.declineTransfer(user.id, parse(uuidSchema, id));
  }

  @Post('registrations/:id/refund-requests')
  async requestRefund(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.refunds.request(user.id, parse(uuidSchema, id), parse(refundRequestSchema, body));
  }
}

function view(r: Record<string, any>) {
  return {
    id: r.id,
    registrationNo: r.registration_no,
    status: r.status,
    bibNumber: r.bib_number,
    // The QR is only useful (and only shown) once the place is paid for.
    qrToken: r.status === 'confirmed' ? r.qr_token : null,
    shirtSize: r.shirt_size,
    ageGroup: r.age_group,
    kitPickedUpAt: r.kit_picked_up_at,
    runner: { en: `${r.first_name_en} ${r.last_name_en}`, th: r.first_name_th ? `${r.first_name_th} ${r.last_name_th ?? ''}`.trim() : null },
    race: { code: r.race_code, distanceKm: Number(r.distance_km), startAt: r.start_at, cutoffMinutes: r.cutoff_minutes },
    event: { slug: r.event_slug, name: r.event_name, eventDate: r.event_date, venue: r.venue_name, coverImageUrl: r.cover_image_url },
    orderNo: r.order_no,
  };
}
