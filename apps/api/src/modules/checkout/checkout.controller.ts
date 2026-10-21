import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, AuthUser, CurrentUser } from '../../common/auth';
import { parse, uuidSchema } from '../../common/validation';
import { CheckoutService, MAX_RUNNERS_PER_ORDER } from './checkout.service';

const createSchema = z.object({
  eventId: z.string().uuid(),
  races: z
    .array(z.object({ raceId: z.string().uuid(), quantity: z.number().int().min(1).max(MAX_RUNNERS_PER_ORDER) }))
    .min(1)
    .max(MAX_RUNNERS_PER_ORDER),
  variants: z
    .array(z.object({ variantId: z.string().uuid(), quantity: z.number().int().min(1).max(MAX_RUNNERS_PER_ORDER) }))
    .max(30)
    .default([]),
});

const variantsSchema = z.object({
  variants: z
    .array(z.object({ variantId: z.string().uuid(), quantity: z.number().int().min(1).max(MAX_RUNNERS_PER_ORDER) }))
    .max(30),
});

@Controller('checkout/sessions')
@UseGuards(AuthGuard)
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.checkout.create(user.id, parse(createSchema, body));
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.checkout.get(user.id, parse(uuidSchema, id));
  }

  @Put(':id/variants')
  setVariants(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const { variants } = parse(variantsSchema, body);
    return this.checkout.setVariants(user.id, parse(uuidSchema, id), variants);
  }

  @Delete(':id')
  @HttpCode(204)
  async cancel(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    await this.checkout.cancel(user.id, parse(uuidSchema, id));
  }
}
