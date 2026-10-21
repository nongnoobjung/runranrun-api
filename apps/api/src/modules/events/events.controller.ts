import { Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { RateLimit } from '../../common/rate-limit';
import { parse } from '../../common/validation';
import { EventsService } from './events.service';

const listQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  province: z.string().max(10).optional(),
  type: z.enum(['road', 'trail', 'virtual', 'ultra', 'fun_run']).optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  /** Events with at least one race in this band of distances. */
  distance: z.enum(['short', '10k', 'half', 'full', 'ultra']).optional(),
  /** Only events taking registrations right now with a place left. */
  open: z.enum(['0', '1', 'true', 'false']).transform((v) => v === '1' || v === 'true').optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const slugSchema = z.string().regex(/^[a-z0-9-]{3,100}$/i);

const resultsQuery = z.object({
  race: z.string().uuid().optional(),
  q: z.string().trim().min(1).max(100).optional(),
  gender: z.enum(['male', 'female']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ResultsQuery = z.infer<typeof resultsQuery>;

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  @RateLimit('public')
  list(@Query() query: unknown) {
    return this.events.list(parse(listQuery, query));
  }

  /** What the search filters can offer: provinces and months that have upcoming events. */
  @Get('filters')
  @RateLimit('public')
  filters() {
    return this.events.filters();
  }

  @Get(':slug')
  @RateLimit('public')
  get(@Param('slug') slug: string) {
    return this.events.getBySlug(parse(slugSchema, slug));
  }

  /** Published results of one race (the first by default), searchable by name or bib. */
  @Get(':slug/results')
  @RateLimit('public')
  results(@Param('slug') slug: string, @Query() query: unknown) {
    return this.events.results(parse(slugSchema, slug), parse(resultsQuery, query));
  }

  @Get(':slug/availability')
  @RateLimit('public')
  availability(@Param('slug') slug: string) {
    return this.events.availability(parse(slugSchema, slug));
  }
}
