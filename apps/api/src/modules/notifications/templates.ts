/**
 * Transactional email templates, one per event the runner should hear about, in Thai and English. The row in
 * notifications keeps only the template key, the recipient's language and the facts (`vars`); the text is written
 * when the email is sent, so links always use the current PUBLIC_WEB_URL.
 */
export type Locale = 'th' | 'en';

export interface Localized {
  th: string;
  en: string | null;
}

export interface TemplateVars {
  order_paid: {
    orderId: string;
    orderNo: string;
    event: Localized;
    eventDate: string;
    totalSatang: number;
    registrations: { id: string; name: Localized; raceCode: string; bib: string | null }[];
  };
  bib_assigned: { registrationId: string; event: Localized; raceCode: string; name: Localized; bib: string; previousBib: string | null };
  refund_approved: { event: Localized; raceCode: string | null; name: Localized | null; amountSatang: number; byTransfer: boolean };
  refund_rejected: { event: Localized; raceCode: string; name: Localized; note: string | null };
  refund_transferred: { event: Localized; raceCode: string; name: Localized; amountSatang: number; reference: string };
  transfer_sent: { event: Localized; raceCode: string; toName: Localized };
  transfer_received: { registrationId: string; event: Localized; raceCode: string; name: Localized; bib: string | null };
  race_change_completed: { registrationId: string; event: Localized; fromRace: string; toRace: string; name: Localized; bib: string | null };
  waitlist_offer: { event: Localized; eventSlug: string; raceCode: string; expiresAt: string };
  results_published: { event: Localized; eventSlug: string; raceCode: string; name: Localized; timeMs: number | null; rank: number | null };
}

export type TemplateKey = keyof TemplateVars;
export const TEMPLATE_KEYS = [
  'order_paid', 'bib_assigned', 'refund_approved', 'refund_rejected', 'refund_transferred',
  'transfer_sent', 'transfer_received', 'race_change_completed', 'waitlist_offer', 'results_published',
] as const satisfies readonly TemplateKey[];

export interface RenderedEmail {
  subject: string;
  text: string;
}

/** Builds absolute links into the runner site in the reader's language (English pages live under /en). */
type LinkFn = (path: string) => string;

const SIGNATURE: Record<Locale, string> = {
  th: '— ทีมงานก้าว\nอีเมลนี้ส่งอัตโนมัติเกี่ยวกับการสมัครของคุณ',
  en: '— The Kao team\nThis is an automatic email about your registration.',
};

export function baht(satang: number, locale: Locale): string {
  const n = new Intl.NumberFormat(locale === 'th' ? 'th-TH' : 'en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(satang / 100);
  return `฿${n}`;
}

function dateTime(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'th' ? 'th-TH' : 'en-GB', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok',
  }).format(new Date(iso));
}

function date(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'th' ? 'th-TH' : 'en-GB', { dateStyle: 'long', timeZone: 'Asia/Bangkok' }).format(new Date(`${iso}T12:00:00+07:00`));
}

function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

const pick = (e: Localized, locale: Locale) => (locale === 'en' && e.en?.trim() ? e.en : e.th);

type Template<K extends TemplateKey> = (v: TemplateVars[K], locale: Locale, link: LinkFn) => RenderedEmail;

const TEMPLATES: { [K in TemplateKey]: Template<K> } = {
  order_paid: (v, l, link) => {
    const ev = pick(v.event, l);
    const lines = v.registrations.map((r) =>
      l === 'th'
        ? `• ${pick(r.name, l)} — ${r.raceCode} · บิบ ${r.bib ?? 'รอผู้จัดออกเลข'}\n  บัตรเข้างาน: ${link(`/me/registrations/${r.id}`)}`
        : `• ${pick(r.name, l)} — ${r.raceCode} · bib ${r.bib ?? 'to be assigned by the organiser'}\n  Ticket: ${link(`/me/registrations/${r.id}`)}`,
    );
    return l === 'th'
      ? {
          subject: `ชำระเงินสำเร็จ: ${ev} (คำสั่งซื้อ ${v.orderNo})`,
          text: [
            `ขอบคุณที่สมัคร ${ev} วันที่ ${date(v.eventDate, l)}`,
            `เราได้รับเงิน ${baht(v.totalSatang, l)} สำหรับคำสั่งซื้อ ${v.orderNo} แล้ว`,
            '', ...lines, '',
            `ใบเสร็จรับเงิน (พิมพ์ได้ หรือขอใบกำกับภาษีเต็มรูป): ${link(`/orders/${v.orderId}/receipt`)}`,
            '', SIGNATURE.th,
          ].join('\n'),
        }
      : {
          subject: `Payment received: ${ev} (order ${v.orderNo})`,
          text: [
            `Thank you for registering for ${ev} on ${date(v.eventDate, l)}.`,
            `We have received ${baht(v.totalSatang, l)} for order ${v.orderNo}.`,
            '', ...lines, '',
            `Receipt (print it, or ask for a full tax invoice): ${link(`/orders/${v.orderId}/receipt`)}`,
            '', SIGNATURE.en,
          ].join('\n'),
        };
  },

  bib_assigned: (v, l, link) => {
    const ev = pick(v.event, l);
    const ticket = link(`/me/registrations/${v.registrationId}`);
    if (l === 'th') {
      return {
        subject: v.previousBib ? `เปลี่ยนเลขบิบ ${ev}: ${v.bib}` : `เลขบิบของคุณ ${ev}: ${v.bib}`,
        text: [
          `${pick(v.name, l)} (${v.raceCode})`,
          v.previousBib ? `ผู้จัดเปลี่ยนเลขบิบจาก ${v.previousBib} เป็น ${v.bib}` : `ผู้จัดออกเลขบิบให้คุณแล้ว: ${v.bib}`,
          `ดูบัตรเข้างาน: ${ticket}`, '', SIGNATURE.th,
        ].join('\n'),
      };
    }
    return {
      subject: v.previousBib ? `Your bib for ${ev} changed: ${v.bib}` : `Your bib for ${ev}: ${v.bib}`,
      text: [
        `${pick(v.name, l)} (${v.raceCode})`,
        v.previousBib ? `The organiser changed your bib from ${v.previousBib} to ${v.bib}.` : `The organiser has given you bib ${v.bib}.`,
        `Your ticket: ${ticket}`, '', SIGNATURE.en,
      ].join('\n'),
    };
  },

  refund_approved: (v, l, link) => {
    const ev = pick(v.event, l);
    const who = v.name && v.raceCode ? `${pick(v.name, l)} (${v.raceCode})` : null;
    if (l === 'th') {
      return {
        subject: `อนุมัติคืนเงิน ${baht(v.amountSatang, l)}: ${ev}`,
        text: [
          ...(who ? [who] : []),
          `ผู้จัดอนุมัติคืนเงิน ${baht(v.amountSatang, l)} แล้ว`,
          v.byTransfer ? 'ผู้จัดจะโอนเงินเข้าบัญชีที่คุณให้ไว้ และเราจะแจ้งอีกครั้งเมื่อโอนแล้ว' : 'เงินจะคืนเข้าบัตรที่ใช้ชำระ ภายในรอบบิลของธนาคาร',
          `ประวัติการสมัคร: ${link('/me/events')}`, '', SIGNATURE.th,
        ].join('\n'),
      };
    }
    return {
      subject: `Refund of ${baht(v.amountSatang, l)} approved: ${ev}`,
      text: [
        ...(who ? [who] : []),
        `The organiser approved a refund of ${baht(v.amountSatang, l)}.`,
        v.byTransfer ? 'The organiser will transfer the money to the bank account you gave; we will email you again once it is sent.' : 'The money goes back to the card you paid with, within your bank’s billing cycle.',
        `Your registrations: ${link('/me/events')}`, '', SIGNATURE.en,
      ].join('\n'),
    };
  },

  refund_rejected: (v, l, link) => {
    const ev = pick(v.event, l);
    return l === 'th'
      ? {
          subject: `ไม่อนุมัติคำขอคืนเงิน: ${ev}`,
          text: [`${pick(v.name, l)} (${v.raceCode})`, 'ผู้จัดไม่อนุมัติคำขอคืนเงิน ที่นั่งของคุณยังอยู่ตามเดิม', ...(v.note ? [`เหตุผล: ${v.note}`] : []),
            `บัตรเข้างาน: ${link('/me/events')}`, '', SIGNATURE.th].join('\n'),
        }
      : {
          subject: `Refund request declined: ${ev}`,
          text: [`${pick(v.name, l)} (${v.raceCode})`, 'The organiser declined your refund request. Your place stays as it was.', ...(v.note ? [`Reason: ${v.note}`] : []),
            `Your tickets: ${link('/me/events')}`, '', SIGNATURE.en].join('\n'),
        };
  },

  refund_transferred: (v, l) => {
    const ev = pick(v.event, l);
    return l === 'th'
      ? {
          subject: `โอนเงินคืนแล้ว ${baht(v.amountSatang, l)}: ${ev}`,
          text: [`${pick(v.name, l)} (${v.raceCode})`, `ผู้จัดโอนเงินคืน ${baht(v.amountSatang, l)} แล้ว`, `เลขอ้างอิงการโอน: ${v.reference}`, '', SIGNATURE.th].join('\n'),
        }
      : {
          subject: `Refund of ${baht(v.amountSatang, l)} sent: ${ev}`,
          text: [`${pick(v.name, l)} (${v.raceCode})`, `The organiser has transferred ${baht(v.amountSatang, l)} back to you.`, `Transfer reference: ${v.reference}`, '', SIGNATURE.en].join('\n'),
        };
  },

  transfer_sent: (v, l, link) => {
    const ev = pick(v.event, l);
    return l === 'th'
      ? {
          subject: `โอนสิทธิ์สำเร็จ: ${ev} ${v.raceCode}`,
          text: [`สิทธิ์ ${v.raceCode} ของคุณโอนให้ ${pick(v.toName, l)} เรียบร้อยแล้ว บัตรเข้างานเดิมใช้ไม่ได้อีก`, `ประวัติการสมัคร: ${link('/me/events')}`, '', SIGNATURE.th].join('\n'),
        }
      : {
          subject: `Place transferred: ${ev} ${v.raceCode}`,
          text: [`Your ${v.raceCode} place now belongs to ${pick(v.toName, l)}. Your old ticket no longer works.`, `Your registrations: ${link('/me/events')}`, '', SIGNATURE.en].join('\n'),
        };
  },

  transfer_received: (v, l, link) => {
    const ev = pick(v.event, l);
    const ticket = link(`/me/registrations/${v.registrationId}`);
    return l === 'th'
      ? {
          subject: `ได้รับสิทธิ์แล้ว: ${ev} ${v.raceCode}`,
          text: [`${pick(v.name, l)} ได้รับสิทธิ์ ${v.raceCode} เรียบร้อยแล้ว${v.bib ? ` · บิบ ${v.bib}` : ''}`, `บัตรเข้างาน: ${ticket}`, '', SIGNATURE.th].join('\n'),
        }
      : {
          subject: `Place received: ${ev} ${v.raceCode}`,
          text: [`${pick(v.name, l)} now holds the ${v.raceCode} place${v.bib ? ` · bib ${v.bib}` : ''}.`, `Ticket: ${ticket}`, '', SIGNATURE.en].join('\n'),
        };
  },

  race_change_completed: (v, l, link) => {
    const ev = pick(v.event, l);
    const ticket = link(`/me/registrations/${v.registrationId}`);
    return l === 'th'
      ? {
          subject: `เปลี่ยนระยะสำเร็จ: ${ev} ${v.fromRace} → ${v.toRace}`,
          text: [`${pick(v.name, l)} เปลี่ยนจาก ${v.fromRace} เป็น ${v.toRace} แล้ว`, `เลขบิบใหม่: ${v.bib ?? 'รอผู้จัดออกเลข'}`, `บัตรเข้างาน: ${ticket}`, '', SIGNATURE.th].join('\n'),
        }
      : {
          subject: `Race changed: ${ev} ${v.fromRace} → ${v.toRace}`,
          text: [`${pick(v.name, l)} has moved from ${v.fromRace} to ${v.toRace}.`, `New bib: ${v.bib ?? 'to be assigned by the organiser'}`, `Ticket: ${ticket}`, '', SIGNATURE.en].join('\n'),
        };
  },

  waitlist_offer: (v, l, link) => {
    const ev = pick(v.event, l);
    return l === 'th'
      ? {
          subject: `มีที่ว่างให้คุณแล้ว: ${ev} ${v.raceCode}`,
          text: [`ถึงคิวของคุณในรายชื่อสำรอง ${v.raceCode}`, `ที่นั่งนี้เก็บไว้ให้ถึง ${dateTime(v.expiresAt, l)} กดสมัครและชำระเงินก่อนเวลานี้`,
            `สมัครเลย: ${link('/me/waitlist')}`, '', SIGNATURE.th].join('\n'),
        }
      : {
          subject: `A place is yours: ${ev} ${v.raceCode}`,
          text: [`Your turn on the ${v.raceCode} waitlist has come.`, `The place is held for you until ${dateTime(v.expiresAt, l)}; register and pay before then.`,
            `Claim it: ${link('/me/waitlist')}`, '', SIGNATURE.en].join('\n'),
        };
  },

  results_published: (v, l, link) => {
    const ev = pick(v.event, l);
    const results = link(`/events/${v.eventSlug}/results`);
    const time = v.timeMs !== null ? duration(v.timeMs) : null;
    return l === 'th'
      ? {
          subject: `ผลการแข่งขัน ${ev} ออกแล้ว`,
          text: [`ยินดีด้วย ${pick(v.name, l)} ที่วิ่งจบ ${v.raceCode}!`, ...(time ? [`เวลา ${time}${v.rank ? ` · อันดับ ${v.rank}` : ''}`] : []),
            `ดูผลทั้งหมด: ${results}`, '', SIGNATURE.th].join('\n'),
        }
      : {
          subject: `Results are out: ${ev}`,
          text: [`Congratulations ${pick(v.name, l)} on finishing the ${v.raceCode}!`, ...(time ? [`Time ${time}${v.rank ? ` · place ${v.rank}` : ''}`] : []),
            `All results: ${results}`, '', SIGNATURE.en].join('\n'),
        };
  },
};

export function isTemplateKey(key: string): key is TemplateKey {
  return (TEMPLATE_KEYS as readonly string[]).includes(key);
}

export function renderTemplate<K extends TemplateKey>(key: K, vars: TemplateVars[K], locale: Locale, webUrl: string): RenderedEmail {
  const base = webUrl.replace(/\/$/, '');
  const link: LinkFn = (path) => `${base}${locale === 'en' ? '/en' : ''}${path}`;
  return (TEMPLATES[key] as Template<K>)(vars, locale, link);
}
