import type { EventMeta } from "@gen/shared";

const SENSITIVE_FIELD_RE =
  /\b(pass(word|wd|code)?|pwd|secret|api[-_]?key|private[-_]?key|access[-_]?token|auth[-_]?token|bearer|cvv|cvc|csc|card[-_]?num(ber)?|cc[-_]?num|iban|bic|swift|ssn|social[-_]?security|afm|amka|tax[-_]?id|pin[-_]?code|otp|2fa)\b/i;

const AUTOFILL_ELIGIBLE_RE =
  /\b(name|first[-_]?name|last[-_]?name|full[-_]?name|email|e-mail|phone|tel|mobile|company|organization|org|address|street|city|zip|postal|postcode|country|vat|tin)\b/i;

const CARD_PATTERN = /\b(?:\d[ -]*?){13,19}\b/g;
const IBAN_PATTERN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;
const SECRET_TOKEN_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,})\b/g;
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_PATTERN =
  /(?<![A-Za-z0-9_-])(?:\+\d{1,3}[\s-]?)?(?:\(\d{2,4}\)[\s-]?)?\d{3,4}[\s-]?\d{3,4}[\s-]?\d{2,4}\b/g;

const SENSITIVE_URL_PARAM_RE =
  /^(token|access_token|id_token|refresh_token|code|password|passwd|secret|api_key|apikey|key|sig|signature|session_key)$/i;

export function hashValue(input: string): string {
  const normalized = input.trim().toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return "h_" + (hash >>> 0).toString(16).padStart(8, "0");
}

function luhnCheck(digitsOnly: string): boolean {
  if (digitsOnly.length < 13 || digitsOnly.length > 19) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = digitsOnly.length - 1; i >= 0; i--) {
    let digit = digitsOnly.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return false;
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

export interface ElementPrivacyCheck {
  isSensitiveField: boolean;
  reason?: NonNullable<EventMeta["privacy"]>["reason"];
  autofillEligible: boolean;
  autocompleteAttr?: string;
}

export function inspectElementPrivacy(el: Element | null): ElementPrivacyCheck {
  if (!el || !(el instanceof HTMLElement)) {
    return { isSensitiveField: false, autofillEligible: false };
  }

  const tag = el.tagName.toLowerCase();
  const typeAttr = (el.getAttribute("type") || "").toLowerCase();
  const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase().trim();
  const nameAttr = el.getAttribute("name") || "";
  const idAttr = el.getAttribute("id") || "";
  const placeholder = el.getAttribute("placeholder") || "";
  const ariaLabel = el.getAttribute("aria-label") || "";
  const combinedDescriptor = `${nameAttr} ${idAttr} ${placeholder} ${ariaLabel} ${autocomplete}`;

  if (typeAttr === "password") {
    return {
      isSensitiveField: true,
      reason: "password_field",
      autofillEligible: true,
      autocompleteAttr: autocomplete || undefined,
    };
  }

  if (
    autocomplete.startsWith("cc-") ||
    /\b(cvv|cvc|card[-_]?num|iban)\b/i.test(combinedDescriptor)
  ) {
    return {
      isSensitiveField: true,
      reason: "payment_field",
      autofillEligible: true,
      autocompleteAttr: autocomplete || undefined,
    };
  }

  if (
    autocomplete === "new-password" ||
    autocomplete === "current-password" ||
    autocomplete === "one-time-code" ||
    SENSITIVE_FIELD_RE.test(combinedDescriptor)
  ) {
    return {
      isSensitiveField: true,
      reason: "secret_field",
      autofillEligible: false,
      autocompleteAttr: autocomplete || undefined,
    };
  }

  const autofillEligible =
    (tag === "input" || tag === "select" || tag === "textarea") &&
    ((autocomplete !== "" && autocomplete !== "off") ||
      typeAttr === "email" ||
      typeAttr === "tel" ||
      AUTOFILL_ELIGIBLE_RE.test(combinedDescriptor));

  return {
    isSensitiveField: false,
    autofillEligible,
    autocompleteAttr: autocomplete || undefined,
  };
}

export function sanitizeValue(
  rawValue: string | undefined,
  elCheck?: ElementPrivacyCheck
): { value: string | undefined; privacy: NonNullable<EventMeta["privacy"]> } {
  if (rawValue === undefined || rawValue === null) {
    return { value: undefined, privacy: { redacted: false } };
  }

  const valueLength = rawValue.length;
  const valueHash = valueLength > 0 ? hashValue(rawValue) : undefined;

  if (elCheck?.isSensitiveField) {
    const piiType =
      elCheck.reason === "password_field"
        ? "password"
        : elCheck.reason === "payment_field"
          ? "credit_card"
          : "secret_token";
    return {
      value: `[REDACTED:${piiType.toUpperCase()}#${valueHash || "empty"}]`,
      privacy: {
        redacted: true,
        reason: elCheck.reason,
        piiTypes: [piiType],
        valueHash,
        valueLength,
      },
    };
  }

  let scrubbed = rawValue;
  const piiTypes = new Set<
    "password" | "credit_card" | "iban" | "secret_token" | "ssn_tax_id" | "email" | "phone"
  >();
  let redacted = false;

  scrubbed = scrubbed.replace(SECRET_TOKEN_PATTERN, (match) => {
    redacted = true;
    piiTypes.add("secret_token");
    return `[REDACTED:TOKEN#${hashValue(match)}]`;
  });

  scrubbed = scrubbed.replace(IBAN_PATTERN, (match) => {
    redacted = true;
    piiTypes.add("iban");
    return `[REDACTED:IBAN#${hashValue(match)}]`;
  });

  scrubbed = scrubbed.replace(CARD_PATTERN, (match) => {
    const digits = match.replace(/\D/g, "");
    if (luhnCheck(digits)) {
      redacted = true;
      piiTypes.add("credit_card");
      return `[REDACTED:CARD#${hashValue(digits)}]`;
    }
    return match;
  });

  if (EMAIL_PATTERN.test(scrubbed)) {
    piiTypes.add("email");
  }
  EMAIL_PATTERN.lastIndex = 0;

  if (PHONE_PATTERN.test(scrubbed) && scrubbed.replace(/\D/g, "").length >= 10) {
    piiTypes.add("phone");
  }
  PHONE_PATTERN.lastIndex = 0;

  if (scrubbed.length > 500) {
    scrubbed = scrubbed.slice(0, 500) + `... [truncated ${scrubbed.length - 500} chars]`;
  }

  return {
    value: scrubbed,
    privacy: {
      redacted,
      reason: redacted ? "pii_pattern" : undefined,
      piiTypes: piiTypes.size > 0 ? Array.from(piiTypes) : undefined,
      valueHash,
      valueLength,
    },
  };
}

export function sanitizeUrl(rawUrl: string | undefined): {
  url: string | undefined;
  hadSensitiveParams: boolean;
} {
  if (!rawUrl) return { url: undefined, hadSensitiveParams: false };
  try {
    const parsed = new URL(rawUrl);
    let hadSensitiveParams = false;
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_URL_PARAM_RE.test(key)) {
        parsed.searchParams.set(key, "[REDACTED]");
        hadSensitiveParams = true;
      }
    }
    return { url: parsed.toString(), hadSensitiveParams };
  } catch {
    return { url: rawUrl, hadSensitiveParams: false };
  }
}
