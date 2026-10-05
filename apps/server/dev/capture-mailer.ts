// The local stack's mailer: keeps every email, and writes each to a file with
// its links, instead of sending it. It says it is live, so sign-up works.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Mail, Mailer, SendResult } from '../src/mailer.ts';

export class CaptureMailer implements Mailer {
  readonly mode = 'live' as const;
  readonly captured: Mail[] = [];
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = join(dir, 'mail');
  }
  async send(mail: Mail): Promise<SendResult> {
    this.captured.push(mail);
    mkdirSync(this.dir, { recursive: true });
    const n = String(this.captured.length).padStart(3, '0');
    writeFileSync(join(this.dir, `${n}-${mail.kind}.txt`), `To: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n`);
    return 'sent';
  }
  close() {}
}
