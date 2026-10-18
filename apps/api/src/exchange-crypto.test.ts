import { describe, expect, it } from "vitest";
import { canonicalJson, fingerprint, generateKeyPair, openKey, sealKey, signPayload, verifyPayload, withinWindow } from "./exchange-crypto.js";

describe("exchange crypto", () => {
  it("canonical JSON ignores key order and undefined, and nests", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"x":2,"y":1}]},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it("signs and verifies, and any change, wrong key or junk fails", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const doc = { id: "m1", type: "purchase_order", body: { lines: [{ sku: "X", qty: 5 }] } };
    const sig = signPayload(doc, a.privateKey);
    expect(verifyPayload({ ...doc, body: { lines: [{ sku: "X", qty: 5 }] } }, sig, a.publicKey)).toBe(true); // rebuilt copy
    expect(verifyPayload({ ...doc, body: { lines: [{ sku: "X", qty: 6 }] } }, sig, a.publicKey)).toBe(false); // tampered
    expect(verifyPayload(doc, sig, b.publicKey)).toBe(false); // someone else's key
    expect(verifyPayload(doc, "not-a-signature", a.publicKey)).toBe(false);
    expect(verifyPayload(doc, sig, "not-a-key")).toBe(false);
  });

  it("gives a stable, readable fingerprint", () => {
    const k = generateKeyPair();
    expect(fingerprint(k.publicKey)).toBe(fingerprint(k.publicKey));
    expect(fingerprint(k.publicKey)).toMatch(/^([0-9a-f]{4} ){4}[0-9a-f]{4}$/);
    expect(fingerprint(generateKeyPair().publicKey)).not.toBe(fingerprint(k.publicKey));
  });

  it("seals the private key with a secret and refuses the wrong or missing one", () => {
    const k = generateKeyPair();
    expect(sealKey(k.privateKey, undefined)).toBe(k.privateKey);
    const sealed = sealKey(k.privateKey, "s3cret");
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(sealed).not.toContain(k.privateKey.slice(0, 20));
    expect(openKey(sealed, "s3cret")).toBe(k.privateKey);
    expect(() => openKey(sealed, "wrong")).toThrow();
    expect(() => openKey(sealed, undefined)).toThrow(/sealed/);
    expect(openKey(k.privateKey, undefined)).toBe(k.privateKey);
  });

  it("only accepts messages inside the replay window", () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    expect(withinWindow("2026-10-18T11:58:00Z", now)).toBe(true);
    expect(withinWindow("2026-10-18T12:09:00Z", now)).toBe(true);
    expect(withinWindow("2026-10-18T11:40:00Z", now)).toBe(false);
    expect(withinWindow("2026-10-18T12:20:00Z", now)).toBe(false);
    expect(withinWindow("garbage", now)).toBe(false);
  });
});
