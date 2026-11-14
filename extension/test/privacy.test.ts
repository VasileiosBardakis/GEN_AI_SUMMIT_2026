import { describe, expect, it } from "vitest";
import { EventSchema } from "@gen/shared/schema.ts";
import { hashValue, sanitizeUrl, sanitizeValue } from "../src/privacy.ts";

describe("Eyes Layer-1 privacy & schema validation", () => {
  it("redacts password and payment fields while preserving deterministic valueHash", () => {
    const res = sanitizeValue("MySecretPass123", {
      isSensitiveField: true,
      reason: "password_field",
      autofillEligible: true,
      autocompleteAttr: "current-password",
    });

    expect(res.privacy.redacted).toBe(true);
    expect(res.privacy.reason).toBe("password_field");
    expect(res.privacy.valueLength).toBe(15);
    expect(res.privacy.valueHash).toBe(hashValue("MySecretPass123"));
    expect(res.value).toContain("[REDACTED:PASSWORD#");
    expect(res.value).not.toContain("MySecretPass123");
  });

  it("scrubs inline IBANs and API tokens from free-text inputs", () => {
    const raw =
      "Wire to GR1601101250000000012300695 using token sk-live-9876543210abcdef123456";
    const res = sanitizeValue(raw, {
      isSensitiveField: false,
      autofillEligible: false,
    });

    expect(res.privacy.redacted).toBe(true);
    expect(res.privacy.piiTypes).toContain("iban");
    expect(res.privacy.piiTypes).toContain("secret_token");
    expect(res.value).toContain("[REDACTED:IBAN#");
    expect(res.value).toContain("[REDACTED:TOKEN#");
    expect(res.value).not.toContain("GR1601101250000000012300695");
    expect(res.value).not.toContain("sk-live-9876543210abcdef123456");
  });

  it("sanitizes sensitive OAuth and token parameters in URLs", () => {
    const { url, hadSensitiveParams } = sanitizeUrl(
      "https://example.com/oauth/callback?code=secret_auth_code&state=xyz&access_token=tok_123"
    );
    expect(hadSensitiveParams).toBe(true);
    expect(url).toContain("state=xyz");
    expect(url).not.toContain("secret_auth_code");
    expect(url).not.toContain("tok_123");
  });

  it("validates rich browser events (contextmenu, keydown, mousemove, auth_flow) against EventSchema", () => {
    const sample = {
      v: 1 as const,
      id: "evt_1",
      ts: Date.now(),
      session: "sess_test",
      source: "browser" as const,
      app: "docs.google.com",
      window: "Q4 Pricing - Google Sheets",
      url: "https://docs.google.com/spreadsheets/d/123",
      type: "contextmenu" as const,
      target: {
        locators: [{ kind: "css" as const, value: 'td[data-cell="A1"]' }],
        tag: "td",
        role: "gridcell",
      },
      meta: {
        button: 2,
        grid: { cellRef: "A1", rowIndex: 1, colIndex: 1, sheetName: "Invoices" },
        menu: { trigger: "right_click" as const, menuItemText: "Rename", displayedShortcut: "F2" },
      },
    };

    const parsed = EventSchema.safeParse(sample);
    expect(parsed.success).toBe(true);
  });
});
