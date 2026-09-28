import { z } from "zod";

export const NAME_MAX = 80;
export const MESSAGE_MAX = 2000;
/** More links than this is what spam looks like; a relative pointing at one or two things is not. */
export const MAX_LINKS = 2;

/**
 * One line of text: every control character becomes a space. A name goes into an email's subject, and a CR or LF
 * there would start a header of the sender's choosing.
 */
export function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
}

/** The message as written, with Windows line endings made plain and any other control character dropped. */
function cleanMessage(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
}

const LINK = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;

export function linkCount(text: string): number {
  return text.match(LINK)?.length ?? 0;
}

/** Nothing but links: with them taken out, not a letter or a number is left. */
export function onlyLinks(text: string): boolean {
  return linkCount(text) > 0 && !/[\p{L}\p{N}]/u.test(text.replace(LINK, ""));
}

export type NoteFields = { name: string; email: string | null; message: string };
export type NoteErrors = Partial<Record<keyof NoteFields, string>>;

/** The field a person never sees and a form-filling script fills in. */
export const HONEYPOT_FIELD = "website";

/** What the form sent, handed back with any answer but a thank-you so nothing has to be typed again. */
export type NoteValues = { name: string; email: string; message: string; photo: string; page: string };
export type NoteState =
  | { status: "idle"; token: string }
  | { status: "sent" }
  | { status: "error"; message: string | null; errors: NoteErrors; token: string; values: NoteValues };

const email = z.string().email().max(254);

/** The three fields as the form sent them, checked and cleaned; each problem is said beside its own field. */
export function validateNote(raw: { name: unknown; email: unknown; message: unknown }): { ok: true; note: NoteFields } | { ok: false; errors: NoteErrors } {
  const name = oneLine(typeof raw.name === "string" ? raw.name : "");
  const address = typeof raw.email === "string" ? raw.email.trim() : "";
  const message = cleanMessage(typeof raw.message === "string" ? raw.message : "");
  const errors: NoteErrors = {};
  if (!name) errors.name = "Please tell us your name.";
  else if (name.length > NAME_MAX) errors.name = `Please keep your name to ${NAME_MAX} characters.`;
  if (address && !email.safeParse(address).success) errors.email = "That email address doesn't look quite right. You can leave it blank.";
  if (!message) errors.message = "Please write a message.";
  else if (message.length > MESSAGE_MAX) errors.message = "Please keep your message under 2,000 characters.";
  else if (onlyLinks(message)) errors.message = "Please add a few words, not just a link.";
  else if (linkCount(message) > MAX_LINKS) errors.message = `Please include no more than ${MAX_LINKS} links.`;
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, note: { name, email: address || null, message } };
}
