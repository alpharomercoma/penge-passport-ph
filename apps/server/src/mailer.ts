// Sends through the local Postfix (which signs with DKIM) using nodemailer.
// Until the domain exists, MAIL_MODE=dry-run builds every message in full but
// sends nothing, and logs only what is safe to log.
import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import { DISPLAY_NAME } from 'penge-passport-ph';
import type { Config, MailMode } from './config.ts';
import type { Logger } from './log.ts';
import type { Rendered } from './templates.ts';

export interface Mail extends Rendered {
  to: string;
  kind: 'confirm' | 'alert';
  /** Adds the one-click unsubscribe headers (RFC 8058) that Gmail and Yahoo require. */
  unsubscribeUrl?: string;
}

export type SendResult = 'sent' | 'dry-run' | 'off';

/**
 * True when the mail server surely did not take the message, so sending it
 * again cannot make a duplicate: it answered with a refusal (an SMTP reply
 * code), or the connection was never made. A dropped connection or a timeout
 * part-way through is uncertain: the message may already be queued.
 */
export function wasRefused(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { responseCode?: unknown; syscall?: unknown; code?: unknown };
  if (typeof e.responseCode === 'number' && e.responseCode >= 400) return true;
  if (e.syscall === 'connect' || e.syscall === 'getaddrinfo') return true;
  return e.code === 'EDNS' || e.code === 'EENVELOPE' || e.code === 'ECONFIG';
}

export interface Mailer {
  readonly mode: MailMode;
  send(mail: Mail): Promise<SendResult>;
  close(): void;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function createMailer(config: Config, log: Logger): Mailer {
  const from = { name: DISPLAY_NAME, address: config.mailFrom ?? 'alerts@example.invalid' };
  const transport =
    config.mailMode === 'live'
      ? nodemailer.createTransport({
          host: config.smtp.host,
          port: config.smtp.port,
          secure: false,
          // Postfix on this machine: nothing crosses a network, so no STARTTLS
          // (its certificate would be self-signed). Postfix uses TLS outbound.
          ignoreTLS: LOOPBACK.has(config.smtp.host),
          pool: true,
          maxConnections: 1,
          // 2 a second, under Postfix's 150-a-minute cap for this client.
          rateDelta: 1000,
          rateLimit: 2,
          connectionTimeout: 10_000,
          greetingTimeout: 10_000,
          socketTimeout: 30_000,
          disableFileAccess: true,
          disableUrlAccess: true,
        })
      : nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });

  return {
    mode: config.mailMode,
    async send(mail) {
      if (config.mailMode === 'off') return 'off';
      const headers: Record<string, string> = {
        'Auto-Submitted': 'auto-generated',
        'X-Auto-Response-Suppress': 'All',
        'Feedback-ID': `${mail.kind}:pengepassportph`,
      };
      if (mail.unsubscribeUrl) {
        headers['List-Unsubscribe'] = `<${mail.unsubscribeUrl}>`;
        headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
      }
      const info = await transport.sendMail({
        from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        headers,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      if (config.mailMode === 'dry-run') {
        const message = (info as { message?: Buffer }).message;
        log.info('mail dry-run', {
          kind: mail.kind,
          bytes: message?.length ?? 0,
          // Enough to tell messages apart in the log without revealing who they were for.
          to: createHash('sha256').update(mail.to).digest('hex').slice(0, 8),
        });
        return 'dry-run';
      }
      return 'sent';
    },
    close: () => transport.close(),
  };
}
