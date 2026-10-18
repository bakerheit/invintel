import { afterEach, describe, expect, it } from "vitest";
import { isPublicIp, validateWebhookUrl } from "./webhook-safety.js";

const was = { p: process.env.INVINTEL_WEBHOOKS_ALLOW_PRIVATE, h: process.env.INVINTEL_WEBHOOKS_ALLOW_HTTP };
afterEach(() => {
  for (const [k, v] of [["INVINTEL_WEBHOOKS_ALLOW_PRIVATE", was.p], ["INVINTEL_WEBHOOKS_ALLOW_HTTP", was.h]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("isPublicIp", () => {
  it("allows ordinary public addresses", () => {
    for (const a of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001::200e"]) {
      expect(isPublicIp(a), a).toBe(true);
    }
  });

  it("refuses private, loopback, link-local and reserved IPv4", () => {
    for (const a of [
      "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.255.254",
      "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.1", "192.168.0.1", "192.168.255.255",
      "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
    ]) {
      expect(isPublicIp(a), a).toBe(false);
    }
  });

  it("refuses private and reserved IPv6, including IPv4 hidden inside it", () => {
    for (const a of [
      "::", "::1", "fe80::1", "fe80::abcd%eth0", "fc00::1", "fd12:3456:789a::1", "fec0::1", "ff02::1",
      "2001:db8::1", "2001::1", "2002:7f00:1::", "100::1", "64:ff9b::7f00:1", "64:ff9b::a00:1",
      "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::127.0.0.1",
    ]) {
      expect(isPublicIp(a), a).toBe(false);
    }
    // The same mapped forms around a public IPv4 are public.
    expect(isPublicIp("::ffff:8.8.8.8")).toBe(true);
  });

  it("refuses anything that isn't an address", () => {
    for (const a of ["", "localhost", "example.com", "999.1.1.1", "1.2.3", "1.2.3.4.5", "::g", "1::2::3", "0x7f.0.0.1"]) expect(isPublicIp(a), a).toBe(false);
  });
});

describe("validateWebhookUrl", () => {
  const bad = (url: string) => {
    const r = validateWebhookUrl(url);
    expect(r.ok, url).toBe(false);
    return r.ok ? "" : r.error;
  };

  it("takes a plain https address", () => {
    const r = validateWebhookUrl("https://hooks.example.com/invintel?x=1");
    expect(r.ok).toBe(true);
    expect(validateWebhookUrl("https://8.8.8.8:8443/hook").ok).toBe(true);
    expect(validateWebhookUrl("https://[2606:4700:4700::1111]/hook").ok).toBe(true);
  });

  it("insists on https", () => {
    expect(bad("http://example.com/hook")).toMatch(/https/);
    bad("ftp://example.com/");
    bad("file:///etc/passwd");
    bad("javascript:alert(1)");
    bad("gopher://example.com/");
  });

  it("refuses private names and addresses however they are written", () => {
    for (const u of [
      "https://localhost/hook", "https://LOCALHOST:8443/", "https://api.localhost/", "https://printer.local/", "https://db.internal/",
      "https://metadata.google.internal/computeMetadata/v1/", "https://router.lan/", "https://x.localdomain/",
      "https://127.0.0.1/", "https://10.1.2.3/", "https://192.168.1.1/", "https://169.254.169.254/latest/meta-data/", "https://172.16.0.9/",
      "https://[::1]/", "https://[fe80::1]/", "https://[fd00::1]/", "https://[::ffff:127.0.0.1]/", "https://[::ffff:7f00:1]/",
      "https://2130706433/", "https://0x7f000001/", "https://017700000001/", "https://127.1/", "https://0/", "https://0.0.0.0/",
    ]) {
      bad(u);
    }
  });

  it("refuses credentials in the address and things that aren't addresses", () => {
    expect(bad("https://user:pass@example.com/")).toMatch(/user name/);
    bad("https://user@example.com/");
    bad("not a url");
    bad("");
    bad("https://");
    bad("//example.com/hook");
  });

  it("only relaxes for development when the environment says so", () => {
    process.env.INVINTEL_WEBHOOKS_ALLOW_PRIVATE = "true";
    expect(validateWebhookUrl("http://127.0.0.1:9000/hook").ok).toBe(true);
    delete process.env.INVINTEL_WEBHOOKS_ALLOW_PRIVATE;
    expect(validateWebhookUrl("http://127.0.0.1:9000/hook").ok).toBe(false);
    process.env.INVINTEL_WEBHOOKS_ALLOW_PRIVATE = "yes"; // anything but "true" is off
    expect(validateWebhookUrl("https://127.0.0.1/").ok).toBe(false);
  });
});
