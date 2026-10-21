import { z, ZodTypeAny } from 'zod';

/** Parses untrusted input; a ZodError becomes a 422 problem in ProblemFilter. */
export function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  return schema.parse(input);
}

export const uuidSchema = z.string().uuid();
