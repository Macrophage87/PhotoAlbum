import nodemailer, { type Transporter } from "nodemailer";
import { env } from "@/lib/env";

type Mail = { to: string; subject: string; text: string; html: string };

let transporter: Transporter | null | undefined;

function getTransporter() {
  if (transporter !== undefined) return transporter;
  const e = env();
  if (!e.SMTP_HOST) {
    transporter = null;
    return transporter;
  }
  transporter = nodemailer.createTransport({
    host: e.SMTP_HOST,
    port: e.SMTP_PORT,
    secure: e.SMTP_SECURE,
    auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASS } : undefined,
  });
  return transporter;
}

/** Sends via SMTP when configured; otherwise logs the message so dev/self-hosters can copy the link. */
export async function sendMail(mail: Mail): Promise<void> {
  const t = getTransporter();
  if (!t) {
    console.log(`\n[mail] To: ${mail.to}\n[mail] Subject: ${mail.subject}\n${mail.text}\n`);
    return;
  }
  await t.sendMail({ from: env().SMTP_FROM, ...mail });
}

export function magicLinkEmail(to: string, link: string): Mail {
  return {
    to,
    subject: "Your sign-in link",
    text: `Sign in to the family album:\n\n${link}\n\nThis link works once and expires in 15 minutes.`,
    html: `<p>Sign in to the family album:</p><p><a href="${link}">${link}</a></p><p>This link works once and expires in 15 minutes.</p>`,
  };
}

export function inviteEmail(to: string, link: string, invitedBy: string): Mail {
  return {
    to,
    subject: "You're invited to the family photo album",
    text: `${invitedBy} invited you to the family photo album.\n\nAccept your invite:\n${link}\n\nThe invite expires in 14 days.`,
    html: `<p>${invitedBy} invited you to the family photo album.</p><p><a href="${link}">Accept your invite</a></p><p>The invite expires in 14 days.</p>`,
  };
}
