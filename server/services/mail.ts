import nodemailer from 'nodemailer';
import { config } from '../config.ts';

export const emailLive = () => Boolean(config.smtp.host && config.smtp.from);

interface Mail {
  to: string;
  subject: string;
  text: string;
  attachments?: { filename: string; content: Buffer }[];
}

/** Sends through your mail server. Returns false if none is set up, so callers can say so. */
export async function sendMail(mail: Mail) {
  if (!emailLive()) return false;
  const { host, port, user, pass, from } = config.smtp;
  const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: user ? { user, pass } : undefined });
  await transport.sendMail({ from, ...mail });
  return true;
}
