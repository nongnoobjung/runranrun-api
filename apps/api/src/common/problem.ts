import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

/** RFC 7807 problem with a stable machine-readable `code` the web app can switch on. */
export class ProblemException extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly detail?: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(title);
  }
}

export const problems = {
  notFound: (what: string) => new ProblemException(404, 'NOT_FOUND', `${what} not found`),
  forbidden: () => new ProblemException(403, 'FORBIDDEN', 'You cannot access this resource'),
  unauthorized: () => new ProblemException(401, 'UNAUTHORIZED', 'Sign in to continue'),
  validation: (detail: string, errors?: unknown) =>
    new ProblemException(422, 'VALIDATION_FAILED', 'Some fields are invalid', detail, errors ? { errors } : undefined),
};

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const request = host.switchToHttp().getRequest<FastifyRequest>();
    const body = this.toProblem(exception);
    if (body.status >= 500) {
      this.logger.error(`${request.method} ${request.url}`, exception instanceof Error ? exception.stack : String(exception));
    }
    void reply.status(body.status).header('content-type', 'application/problem+json').send({ ...body, instance: request.url });
  }

  private toProblem(exception: unknown): { status: number; code: string; title: string; [k: string]: unknown } {
    if (exception instanceof ProblemException) {
      // Extra fields go first so they can never overwrite the status, code or title.
      return { ...exception.extra, status: exception.status, code: exception.code, title: exception.title, detail: exception.detail };
    }
    if (exception instanceof ZodError) {
      return {
        status: 422,
        code: 'VALIDATION_FAILED',
        title: 'Some fields are invalid',
        errors: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    }
    if (exception instanceof HttpException) {
      return { status: exception.getStatus(), code: 'HTTP_ERROR', title: exception.message };
    }
    return { status: 500, code: 'INTERNAL', title: 'Something went wrong on our side' };
  }
}
