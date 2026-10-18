import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { buildMime, type OutgoingMail } from "./mime.js";

// Sending email. A MailTransport takes a finished message and gets it out. Two come with Invintel:
//   OutboxTransport  writes each message to a .eml file (the default: nothing leaves the machine, perfect for demos);
//   SmtpTransport    talks SMTP to a server you configure (INVINTEL_SMTP_URL=smtp://user:pass@host:587, or smtps:// for port 465).
// Credentials come from the environment only. They are never logged and never stored in a partner's settings.

export type MailResult = { ok: true; messageId: string; where: string } | { ok: false; error: string; retryable: boolean };

export interface MailTransport {
  readonly kind: "outbox" | "smtp" | string;
  send(mail: OutgoingMail): Promise<MailResult>;
}

export class OutboxTransport implements MailTransport {
  readonly kind = "outbox";
  constructor(public dir = process.env.INVINTEL_OUTBOX_DIR ?? path.join(os.tmpdir(), "invintel-outbox")) {}
  async send(mail: OutgoingMail): Promise<MailResult> {
    let built: ReturnType<typeof buildMime>;
    try {
      built = buildMime(mail);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Bad message", retryable: false };
    }
    try {
      await mkdir(this.dir, { recursive: true });
      const file = path.join(this.dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${built.messageId.replace(/[^a-z0-9]/gi, "").slice(0, 24)}.eml`);
      await writeFile(file, built.raw, { mode: 0o600 });
      return { ok: true, messageId: built.messageId, where: file };
    } catch (e) {
      return { ok: false, error: `Could not write the outbox file: ${e instanceof Error ? e.message : e}`, retryable: true };
    }
  }
}

export interface SmtpConfig {
  host: string;
  port: number;
  /** Implicit TLS (port 465). Otherwise STARTTLS is used when the server offers it. */
  secure: boolean;
  user?: string;
  pass?: string;
  helo?: string;
  timeoutMs?: number;
  /** Only for tests against a local server with a self-signed certificate. */
  rejectUnauthorized?: boolean;
}

export function smtpConfigFromUrl(url: string): SmtpConfig {
  const u = new URL(url);
  if (u.protocol !== "smtp:" && u.protocol !== "smtps:") throw new Error("INVINTEL_SMTP_URL must start with smtp:// or smtps://");
  const secure = u.protocol === "smtps:";
  return { host: u.hostname, port: Number(u.port) || (secure ? 465 : 587), secure, user: u.username ? decodeURIComponent(u.username) : undefined, pass: u.password ? decodeURIComponent(u.password) : undefined };
}

class SmtpError extends Error {
  constructor(message: string, public retryable: boolean) { super(message); }
}

/** A line-at-a-time SMTP conversation. */
class Conn {
  private buf = "";
  private waiters: ((r: { code: number; lines: string[] }) => void)[] = [];
  private pending: string[] = [];
  private failure: Error | null = null;
  private failers: ((e: Error) => void)[] = [];
  constructor(public socket: net.Socket | tls.TLSSocket) { this.attach(socket); }

  private attach(s: net.Socket) {
    s.on("data", (d) => { this.buf += d.toString("utf8"); this.pump(); });
    s.on("error", (e) => this.fail(e));
    s.on("close", () => this.fail(new Error("The connection closed")));
  }
  private fail(e: Error) { this.failure ??= e; for (const f of this.failers.splice(0)) f(e); }
  private pump() {
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      this.pending.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const lines = this.pending.splice(0);
        const w = this.waiters.shift();
        if (w) w({ code: Number(line.slice(0, 3)), lines });
        else this.pending.unshift(...lines);
      }
    }
  }
  upgrade(secure: tls.TLSSocket) { this.buf = ""; this.pending = []; this.socket = secure; this.attach(secure); }
  reply(): Promise<{ code: number; lines: string[] }> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => { this.waiters.push(resolve); this.failers.push(reject); });
  }
  write(s: string) { this.socket.write(s); }
}

export class SmtpTransport implements MailTransport {
  readonly kind = "smtp";
  constructor(private cfg: SmtpConfig) {}

  async send(mail: OutgoingMail): Promise<MailResult> {
    let built: ReturnType<typeof buildMime>;
    try {
      built = buildMime(mail);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Bad message", retryable: false };
    }
    const timeoutMs = this.cfg.timeoutMs ?? 20_000;
    const socket: net.Socket = this.cfg.secure
      ? tls.connect({ host: this.cfg.host, port: this.cfg.port, servername: this.cfg.host, rejectUnauthorized: this.cfg.rejectUnauthorized ?? true })
      : net.connect({ host: this.cfg.host, port: this.cfg.port });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error("The mail server timed out")));
    const conn = new Conn(socket);
    const say = async (line: string, ok: number[]) => {
      conn.write(`${line}\r\n`);
      const r = await conn.reply();
      if (!ok.includes(r.code)) throw new SmtpError(`${r.lines.join(" ").slice(0, 200)}`, r.code >= 400 && r.code < 500);
      return r;
    };
    try {
      const greet = await conn.reply();
      if (greet.code !== 220) throw new SmtpError(`The mail server said: ${greet.lines.join(" ").slice(0, 200)}`, greet.code < 500);
      const helo = this.cfg.helo ?? os.hostname();
      let ehlo = await say(`EHLO ${helo}`, [250]);
      if (!this.cfg.secure && ehlo.lines.some((l) => /STARTTLS/i.test(l))) {
        await say("STARTTLS", [220]);
        const secured = tls.connect({ socket, servername: this.cfg.host, rejectUnauthorized: this.cfg.rejectUnauthorized ?? true });
        conn.upgrade(secured);
        ehlo = await say(`EHLO ${helo}`, [250]);
      }
      if (this.cfg.user) {
        const encrypted = this.cfg.secure || conn.socket instanceof tls.TLSSocket;
        if (!encrypted && process.env.INVINTEL_SMTP_ALLOW_PLAIN_AUTH !== "1") throw new SmtpError("Won't send a password over an unencrypted connection", false);
        await say(`AUTH PLAIN ${Buffer.from(`\0${this.cfg.user}\0${this.cfg.pass ?? ""}`).toString("base64")}`, [235]);
      }
      await say(`MAIL FROM:<${mail.from}>`, [250]);
      for (const rcpt of [...mail.to, ...(mail.cc ?? [])]) await say(`RCPT TO:<${rcpt}>`, [250, 251]);
      await say("DATA", [354]);
      const data = built.raw.replace(/\r\n\./g, "\r\n..").replace(/^\./, "..");
      conn.write(`${data.endsWith("\r\n") ? data : `${data}\r\n`}.\r\n`);
      const done = await conn.reply();
      if (done.code !== 250) throw new SmtpError(done.lines.join(" ").slice(0, 200), done.code >= 400 && done.code < 500);
      conn.write("QUIT\r\n");
      socket.end();
      return { ok: true, messageId: built.messageId, where: `smtp://${this.cfg.host}:${this.cfg.port}` };
    } catch (e) {
      socket.destroy();
      if (e instanceof SmtpError) return { ok: false, error: e.message, retryable: e.retryable };
      return { ok: false, error: e instanceof Error ? e.message : "Could not send", retryable: true };
    }
  }
}

let current: MailTransport | null = null;
export const setMailTransport = (t: MailTransport | null) => { current = t; };

/** The transport for this process: SMTP when INVINTEL_SMTP_URL is set, otherwise the outbox. */
export function getMailTransport(): MailTransport {
  if (current) return current;
  const url = process.env.INVINTEL_SMTP_URL;
  current = url ? new SmtpTransport(smtpConfigFromUrl(url)) : new OutboxTransport();
  return current;
}
