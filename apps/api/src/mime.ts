import { randomBytes } from "node:crypto";

// Builds an email as a MIME message (RFC 5322 / 2045): plain text plus optional attachments. Every header value is
// checked for line breaks first, so nothing a user or supplier typed can add headers or recipients.

export interface Attachment { filename: string; contentType: string; content: Buffer }
export interface OutgoingMail {
  from: string;
  to: string[];
  cc?: string[];
  replyTo?: string;
  subject: string;
  text: string;
  attachments?: Attachment[];
  messageId?: string;
}

const EMAIL = /^[^\s@<>(),;:\\"]+@[^\s@<>(),;:\\"]+\.[^\s@<>(),;:\\"]+$/;
export const isEmail = (s: string) => s.length <= 254 && EMAIL.test(s);

/** Throws on anything that could break out of a header. */
export function headerSafe(value: string, what = "header"): string {
  if (/[\r\n\0]/.test(value)) throw new Error(`The ${what} can't contain line breaks`);
  return value;
}

const word = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);
const wrap76 = (b64: string) => b64.replace(/(.{76})/g, "$1\r\n");

export function newMessageId(domain = "invintel.local") {
  return `<${Date.now().toString(36)}.${randomBytes(8).toString("hex")}@${domain}>`;
}

export function buildMime(mail: OutgoingMail): { raw: string; messageId: string } {
  for (const a of [mail.from, ...mail.to, ...(mail.cc ?? []), ...(mail.replyTo ? [mail.replyTo] : [])]) if (!isEmail(headerSafe(a, "address"))) throw new Error(`"${a}" isn't an email address`);
  if (!mail.to.length) throw new Error("There is no recipient");
  const messageId = mail.messageId ?? newMessageId(mail.from.split("@")[1]);
  const boundary = `=_inv_${randomBytes(12).toString("hex")}`;
  const head = [
    `From: ${mail.from}`,
    `To: ${mail.to.join(", ")}`,
    ...(mail.cc?.length ? [`Cc: ${mail.cc.join(", ")}`] : []),
    ...(mail.replyTo ? [`Reply-To: ${mail.replyTo}`] : []),
    `Subject: ${word(headerSafe(mail.subject, "subject"))}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    "X-Mailer: Invintel",
  ];
  const text = Buffer.from(mail.text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64");
  let body: string;
  if (mail.attachments?.length) {
    const parts = [`--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(text)}\r\n`];
    for (const a of mail.attachments) {
      const name = headerSafe(a.filename, "file name").replace(/["\\]/g, "_");
      parts.push(`--${boundary}\r\nContent-Type: ${headerSafe(a.contentType, "content type")}; name="${word(name)}"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${word(name)}"\r\n\r\n${wrap76(a.content.toString("base64"))}\r\n`);
    }
    body = `${parts.join("")}--${boundary}--\r\n`;
    head.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  } else {
    body = `${wrap76(text)}\r\n`;
    head.push("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64");
  }
  return { raw: `${head.join("\r\n")}\r\n\r\n${body}`, messageId };
}
