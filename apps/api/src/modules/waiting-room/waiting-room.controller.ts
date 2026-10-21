import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, AuthUser, CurrentUser } from '../../common/auth';
import { RateLimit } from '../../common/rate-limit';
import { parse, uuidSchema } from '../../common/validation';
import { WaitingRoomService } from './waiting-room.service';

/** The queue in front of checkout for events with `useWaitingRoom`. One place per runner per event. */
@Controller('checkout/queue')
@UseGuards(AuthGuard)
export class WaitingRoomController {
  constructor(private readonly waitingRoom: WaitingRoomService) {}

  /** Joins at the back (again only after an admission ran out); repeating it keeps the place. */
  @Post()
  @RateLimit('queue')
  join(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const { eventId } = parse(z.object({ eventId: z.string().uuid() }), body);
    return this.waitingRoom.join(user.id, eventId);
  }

  /** Position and estimated wait, or the admission token once it is the runner's turn. */
  @Get(':eventId')
  @RateLimit('queue')
  status(@CurrentUser() user: AuthUser, @Param('eventId') eventId: string) {
    return this.waitingRoom.status(user.id, parse(uuidSchema, eventId));
  }
}
