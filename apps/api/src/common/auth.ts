import { CanActivate, createParamDecorator, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { FastifyRequest } from 'fastify';
import { problems } from './problem';

export interface AuthUser {
  id: string;
}

type AuthedRequest = FastifyRequest & { user?: AuthUser };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw problems.unauthorized();
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(header.slice(7));
      req.user = { id: payload.sub };
      return true;
    } catch {
      throw problems.unauthorized();
    }
  }
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
  if (!user) throw problems.unauthorized();
  return user;
});
