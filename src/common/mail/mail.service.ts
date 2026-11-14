import { Inject, Injectable, Logger } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { APP_CONFIG, AppConfig } from '../config';

/**
 * SMTP mailer. When EMAIL_HOST is not configured (local development) messages are written
 * to the log instead so OTP flows remain testable. In production a missing SMTP config is
 * reported as an error on every send.
 */
@Injectable()
export class MailService {
  private readonly log = new Logger(MailService.name);
  private readonly transport: Transporter | null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    const e = config.email;
    this.transport = e.host
      ? nodemailer.createTransport({
          host: e.host,
          port: e.port,
          secure: e.port === 465,
          auth: e.user ? { user: e.user, pass: e.password ?? '' } : undefined,
        })
      : null;
  }

  get configured(): boolean {
    return this.transport !== null;
  }

  async send(to: string, subject: string, text: string): Promise<void> {
    if (!this.transport) {
      if (this.config.isProd) this.log.error(`EMAIL_HOST not configured; cannot send "${subject}"`);
      else this.log.warn(`[dev-mail] to=${to} subject="${subject}" body="${text}"`);
      return;
    }
    await this.transport.sendMail({ from: this.config.email.from, to, subject, text });
  }

  async sendOtp(to: string, code: string, purpose: string) {
    const what = purpose === 'RESET_PASSWORD' ? 'reset your password' : 'verify your account';
    await this.send(
      to,
      `Your CS Card Station code: ${code}`,
      `Use code ${code} to ${what}. It expires in 10 minutes. If you did not request this, ignore this email.`,
    );
  }
}
