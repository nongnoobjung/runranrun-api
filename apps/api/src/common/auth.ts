import { CanActivate, createParamDecorator, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { FastifyRequest } from 'fastify';
import { DbService } from '../db/db.service';
import { problems } from './problem';

export interface AuthUser {
  id: string;
}

type AuthedRequest = FastifyRequest & { user?: AuthUser };

/**
 * Which front a token was issued for: the runner site, the organiser backoffice or the platform admin.
 * Each lives on its own domain with its own sign-in, so a runner-site session cannot reach the backoffices.
 */
export const AUDIENCES = ['site', 'organizer', 'admin'] as const;
export type Audience = (typeof AUDIENCES)[number];

const AUDIENCE_KEY = 'kao:audience';
/** Limits a controller (or handler) to tokens issued for this front. Routes without it take any signed-in token. */
export const RequireAudience = (audience: Audience) => SetMetadata(AUDIENCE_KEY, audience);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly dbs: DbService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw problems.unauthorized();
    let claims: { sub: string; aud?: string | string[] };
    try {
      claims = await this.jwt.verifyAsync<{ sub: string; aud?: string | string[] }>(header.slice(7));
    } catch {
      throw problems.unauthorized();
    }
    const userId = claims.sub;
    // A token for another front counts as signed out here, so the backoffice sends people to its own sign-in.
    const required = this.reflector.getAllAndOverride<Audience | undefined>(AUDIENCE_KEY, [context.getHandler(), context.getClass()]);
    if (required && ![claims.aud ?? 'site'].flat().includes(required)) throw problems.unauthorized();
    // A token outlives a closed or suspended account; those accounts are signed out straight away.
    const { rows } = await this.dbs.pool.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [userId]);
    if (rows[0]?.status !== 'active') throw problems.unauthorized();
    req.user = { id: userId };
    return true;
  }
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
  if (!user) throw problems.unauthorized();
  return user;
});
