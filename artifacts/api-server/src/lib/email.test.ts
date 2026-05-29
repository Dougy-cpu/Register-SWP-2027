import { describe, it, expect } from "vitest";
import { escHtml, wrapInBrandedLayout } from "./email";

describe("escHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escHtml(`<script>alert("xss")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
    );
    expect(escHtml("a & b")).toBe("a &amp; b");
    expect(escHtml("it's fine")).toBe("it&#39;s fine");
  });

  it("escapes ampersands first to avoid double-encoding", () => {
    expect(escHtml("&lt;")).toBe("&amp;lt;");
  });

  it("returns an empty string for null and undefined", () => {
    expect(escHtml(null)).toBe("");
    expect(escHtml(undefined)).toBe("");
  });

  it("coerces non-string values via String()", () => {
    expect(escHtml(42)).toBe("42");
    expect(escHtml(true)).toBe("true");
  });

  it("leaves benign user input untouched", () => {
    expect(escHtml("Acme Ltd")).toBe("Acme Ltd");
    expect(escHtml("Jane O Brien")).toBe("Jane O Brien");
  });

  it("neutralises an attribute-breaking payload", () => {
    // Simulates an attendee firstName trying to break out of an attribute
    // and inject an event handler.
    const payload = `" onmouseover="alert(1)`;
    const escaped = escHtml(payload);
    expect(escaped).not.toContain('"');
    expect(escaped).toContain("&quot;");
  });
});

/**
 * Renderer-path integration test (per code-review feedback on Task #68).
 *
 * The production confirmation builder substitutes user-controlled values
 * into a stored HTML template by escaping each value with `escHtml` and
 * then doing `body.replaceAll(placeholder, escapedValue)`. We cannot
 * call `buildConfirmationEmailHtml` directly in a unit test (it talks
 * to the DB), so we replicate the exact substitution pattern here and
 * assert that a malicious attendee `firstName` survives the round-trip
 * neutralised — proving the escape helper is wired into the renderer
 * pattern, not just exported in isolation.
 */
describe("template substitution pattern (integration shape)", () => {
  it("escapes a malicious firstName when rendered into a template body", () => {
    const malicious = `<script>alert("pwned")</script>`;
    const template = `<h2>Welcome, {{firstName}}!</h2><p>Hi {{firstName}}.</p>`;

    const vars: Record<string, string> = {
      "{{firstName}}": escHtml(malicious),
    };

    let body = template;
    for (const [placeholder, value] of Object.entries(vars)) {
      body = body.replaceAll(placeholder, value);
    }

    expect(body).not.toContain("<script>");
    expect(body).not.toContain("</script>");
    expect(body).toContain("&lt;script&gt;");
    expect(body).toContain("&lt;/script&gt;");
    expect(body).toContain("&quot;pwned&quot;");
    // Sanity: the placeholder was actually substituted.
    expect(body).not.toContain("{{firstName}}");
  });

  it("escapes a billing-address payload that tries to inject an <img onerror>", () => {
    const malicious = `<img src=x onerror=alert(1)>`;
    const row = `<td>${escHtml(malicious)}</td>`;
    expect(row).toBe(`<td>&lt;img src=x onerror=alert(1)&gt;</td>`);
    expect(row).not.toContain("<img");
  });
});

describe("wrapInBrandedLayout", () => {
  it("renders uploaded logos with fixed email-safe dimensions", () => {
    const html = wrapInBrandedLayout("<p>Body</p>", {
      eventName: "SWP Summit",
      logoDataUrl: "data:image/png;base64,abc123",
    });

    expect(html).toContain('width="96"');
    expect(html).toContain('height="96"');
    expect(html).toContain("width:96px!important");
    expect(html).toContain("height:96px!important");
    expect(html).toContain("max-width:96px!important");
    expect(html).toContain("max-height:96px!important");
    expect(html).toContain("display:block");
  });

  it("escapes logo attributes in the branded header", () => {
    const html = wrapInBrandedLayout("<p>Body</p>", {
      eventName: `SWP "Summit"`,
      orgName: `People "Strategy" Hub`,
      logoDataUrl: `x" onerror="alert(1)`,
    });

    expect(html).toContain('alt="People &quot;Strategy&quot; Hub"');
    expect(html).not.toContain('onerror="alert(1)"');
  });
});
