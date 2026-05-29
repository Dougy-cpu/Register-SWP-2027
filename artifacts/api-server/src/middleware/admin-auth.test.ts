import { describe, it, expect } from "vitest";
import { issueAdminToken, verifyAdminToken, timingSafeStringEqual } from "./admin-auth";

describe("admin token", () => {
  const PW = "correct-horse-battery-staple";

  it("verifies a freshly issued token", () => {
    const { token } = issueAdminToken(PW);
    expect(verifyAdminToken(token, PW)).toEqual({ valid: true });
  });

  it("rejects a missing token", () => {
    expect(verifyAdminToken(undefined, PW)).toEqual({ valid: false, reason: "missing" });
    expect(verifyAdminToken("", PW)).toEqual({ valid: false, reason: "missing" });
  });

  it("rejects a malformed token", () => {
    expect(verifyAdminToken("not-a-token", PW)).toEqual({ valid: false, reason: "malformed" });
    expect(verifyAdminToken("nodot.", PW)).toEqual({ valid: false, reason: "malformed" });
    expect(verifyAdminToken(".123", PW)).toEqual({ valid: false, reason: "malformed" });
    expect(verifyAdminToken("abc.notanumber", PW)).toEqual({ valid: false, reason: "malformed" });
  });

  it("rejects an expired token", () => {
    const { token } = issueAdminToken(PW, -1000);
    expect(verifyAdminToken(token, PW)).toEqual({ valid: false, reason: "expired" });
  });

  it("ignores the password argument (signing key is server-side only)", () => {
    // Tokens are signed with a dedicated server-side secret, NOT the password,
    // so a stolen token cannot be used to mount an offline guess attack on
    // ADMIN_PASSWORD. The password parameter to verifyAdminToken is therefore
    // accepted for backwards compatibility but does not affect verification.
    const { token } = issueAdminToken(PW);
    expect(verifyAdminToken(token, "totally-different-password")).toEqual({ valid: true });
  });

  it("rejects a signature of the wrong length as malformed", () => {
    const { token } = issueAdminToken(PW);
    const idx = token.lastIndexOf(".");
    const exp = token.slice(idx + 1);
    expect(verifyAdminToken(`abcdef.${exp}`, PW)).toEqual({ valid: false, reason: "malformed" });
  });

  it("rejects a token whose payload was tampered with", () => {
    const { token } = issueAdminToken(PW);
    const idx = token.lastIndexOf(".");
    const sig = token.slice(0, idx);
    const exp = Number(token.slice(idx + 1));
    const tampered = `${sig}.${exp + 1}`;
    expect(verifyAdminToken(tampered, PW)).toEqual({ valid: false, reason: "bad_sig" });
  });

  it("rejects a token whose signature was altered", () => {
    const { token } = issueAdminToken(PW);
    const idx = token.lastIndexOf(".");
    const sig = token.slice(0, idx);
    const exp = token.slice(idx + 1);
    // Flip the first hex character.
    const flipped = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
    expect(verifyAdminToken(`${flipped}.${exp}`, PW)).toEqual({
      valid: false,
      reason: "bad_sig",
    });
  });
});

describe("timingSafeStringEqual", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeStringEqual("hello", "hello")).toBe(true);
  });

  it("returns false for different strings of same length", () => {
    expect(timingSafeStringEqual("hello", "world")).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(timingSafeStringEqual("hello", "hello!")).toBe(false);
    expect(timingSafeStringEqual("", "x")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(timingSafeStringEqual("", "")).toBe(true);
  });
});
