import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
export const phone = z.string().regex(/^\+?[0-9-]{9,15}$/, 'invalid phone number');

export const runnerSchema = z.object({
  firstNameTh: z.string().trim().min(1).max(80).optional(),
  lastNameTh: z.string().trim().min(1).max(80).optional(),
  firstNameEn: z.string().trim().min(1).max(60).regex(/^[A-Za-z .'-]+$/, 'English letters only'),
  lastNameEn: z.string().trim().min(1).max(60).regex(/^[A-Za-z .'-]+$/, 'English letters only'),
  gender: z.enum(['male', 'female', 'other']),
  birthDate: isoDate,
  nationality: z.string().length(2),
  idDocType: z.enum(['thai_id', 'passport']),
  idDocNumber: z.string().trim().min(5).max(30),
  email: z.string().email().optional(),
  phone: phone.optional(),
  bloodType: z.enum(['A', 'B', 'AB', 'O', 'unknown']).optional(),
  emergencyName: z.string().trim().min(1).max(100),
  emergencyPhone: phone,
});

/** A runner sent with a registration or a transfer: the ID number may come from one of the user's saved profiles instead. */
export const runnerOrProfileSchema = runnerSchema.extend({ idDocNumber: runnerSchema.shape.idDocNumber.optional() });

export const profileChoice = {
  /** A saved profile of the user's; fills in the ID number when the form leaves it out. */
  profileId: z.string().uuid().optional(),
  /** Keep (or refresh) this runner as a saved profile for next time. */
  saveProfile: z.boolean().optional(),
};

export function requireIdDoc(p: { profileId?: string; runner: { idDocNumber?: string } }, ctx: z.RefinementCtx): void {
  if (!p.profileId && !p.runner.idDocNumber) ctx.addIssue({ code: 'custom', path: ['runner', 'idDocNumber'], message: 'Required' });
}
