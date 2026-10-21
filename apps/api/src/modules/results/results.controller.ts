import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../../common/validation';
import { ResultsService } from './results.service';

const listQuery = z.object({
  /** Part of the event name, Thai or English. */
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const searchQuery = z.object({
  /** A bib (exact) or part of a runner's name. */
  q: z.string().trim().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

@Controller('results')
export class ResultsController {
  constructor(private readonly results: ResultsService) {}

  /** Every event whose results are out, newest race day first. */
  @Get()
  list(@Query() query: unknown) {
    return this.results.list(parse(listQuery, query));
  }

  /** Finds a runner across all published results. */
  @Get('search')
  search(@Query() query: unknown) {
    const { q, limit } = parse(searchQuery, query);
    return this.results.search(q, limit);
  }
}
