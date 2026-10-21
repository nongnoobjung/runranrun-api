import { Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../../common/validation';
import { EventsService } from './events.service';

const listQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  province: z.string().max(10).optional(),
  type: z.enum(['road', 'trail', 'virtual', 'ultra', 'fun_run']).optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const slugSchema = z.string().regex(/^[a-z0-9-]{3,100}$/i);

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  list(@Query() query: unknown) {
    return this.events.list(parse(listQuery, query));
  }

  @Get(':slug')
  get(@Param('slug') slug: string) {
    return this.events.getBySlug(parse(slugSchema, slug));
  }

  @Get(':slug/availability')
  availability(@Param('slug') slug: string) {
    return this.events.availability(parse(slugSchema, slug));
  }
}
