import { CanActivate, createParamDecorator, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { FastifyRequest } from 'fastify';
import { DbService } from '../db/db.service';
import { problems } from './problem';

export interface AuthUser {
  id: string;
}

type AuthedRequest = FastifyRequest & { user?: AuthUser };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly dbs: DbService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw problems.unauthorized();
    let userId: string;
    try {
      userId = (await this.jwt.verifyAsync<{ sub: string }>(header.slice(7))).sub;
    } catch {
      throw problems.unauthorized();
    }
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
