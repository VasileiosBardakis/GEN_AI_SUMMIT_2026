import { describe, expect, it, vi } from "vitest";
import {
  createGeminiClient,
  type GeminiClient,
  type GeminiSdk,
} from "../src/llm/gemini.ts";
import {
  refindElement,
  RefindResultSchema,
  type RefindPageElement,
} from "../src/exp/refind.ts";

function makeMockClient(): {
  client: GeminiClient;
  generateText: ReturnType<typeof vi.fn>;
  generateJson: ReturnType<typeof vi.fn>;
} {
  const generateText = vi.fn();
  const generateJson = vi.fn();
  const client: GeminiClient = {
    generateText: generateText as GeminiClient["generateText"],
    generateJson: generateJson as GeminiClient["generateJson"],
  };
  return { client, generateText, generateJson };
}

describe("RefindResultSchema", () => {
  it("accepts valid { locators, why } and { locators: null, why } payloads", () => {
    expect(
      RefindResultSchema.safeParse({
        locators: [
          { kind: "testid", value: "save-changes-btn" },
          { kind: "aria", value: "Save Changes" },
          { kind: "css", value: "button.primary" },
          { kind: "text", value: "Save Changes" },
          { kind: "uia", value: "Name=Save Changes" },
        ],
        why: "  Button was renamed from Save to Save Changes. ",
      }),
    ).toEqual({
      success: true,
      data: {
        locators: [
          { kind: "testid", value: "save-changes-btn" },
          { kind: "aria", value: "Save Changes" },
          { kind: "css", value: "button.primary" },
          { kind: "text", value: "Save Changes" },
          { kind: "uia", value: "Name=Save Changes" },
        ],
        why: "Button was renamed from Save to Save Changes.",
      },
    });

    expect(
      RefindResultSchema.safeParse({
        locators: null,
        why: "No matching element found on the current page.",
      }),
    ).toEqual({
      success: true,
      data: {
        locators: null,
        why: "No matching element found on the current page.",
      },
    });
  });

  it("rejects invalid locator kinds, empty values, and non-string or empty why", () => {
    expect(RefindResultSchema.safeParse(null).success).toBe(false);
    expect(RefindResultSchema.safeParse([]).success).toBe(false);
    expect(
      RefindResultSchema.safeParse({
        locators: [{ kind: "xpath", value: "//button" }],
        why: "Invalid locator kind",
      }).success,
    ).toBe(false);
    expect(
      RefindResultSchema.safeParse({
        locators: [{ kind: "testid", value: "" }],
        why: "Empty locator value",
      }).success,
    ).toBe(false);
    expect(
      RefindResultSchema.safeParse({
        locators: [{ kind: "aria", value: "   " }],
        why: "Blank locator value",
      }).success,
    ).toBe(false);
    expect(
      RefindResultSchema.safeParse({
        locators: [{ kind: "css", value: 123 }],
        why: "Numeric locator value",
      }).success,
    ).toBe(false);
    expect(
      RefindResultSchema.safeParse({
        locators: "not-an-array",
        why: "Invalid locators shape",
      }).success,
    ).toBe(false);
    expect(
      RefindResultSchema.safeParse({
        locators: null,
        why: 42,
      }).success,
    ).toBe(false);
    expect(
      RefindResultSchema.safeParse({
        locators: null,
        why: "   ",
      }).success,
    ).toBe(false);
    expect(
      RefindResultSchema.safeParse({
        locators: null,
      }).success,
    ).toBe(false);
  });
});

describe("refindElement (offline)", () => {
  it("(1) returns { locators: null, why: 'Empty page summary' } with 0 Gemini calls when pageSummary is empty", async () => {
    const { client, generateText, generateJson } = makeMockClient();
    const step = {
      action: "click" as const,
      locators: [{ kind: "testid" as const, value: "save-btn" }],
      label: "Save",
      role: "button",
    };

    await expect(refindElement({ step, pageSummary: [] }, client)).resolves.toEqual({
      locators: null,
      why: "Empty page summary",
    });
    await expect(refindElement({ step, pageSummary: "" }, client)).resolves.toEqual({
      locators: null,
      why: "Empty page summary",
    });
    await expect(refindElement({ step, pageSummary: "   \n\t " }, client)).resolves.toEqual({
      locators: null,
      why: "Empty page summary",
    });

    expect(generateJson).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();

    // Also works without an injected client or credentials
    await expect(refindElement({ step, pageSummary: [] })).resolves.toEqual({
      locators: null,
      why: "Empty page summary",
    });
  });

  it("(2) relocates a renamed button ('Save' -> 'Save Changes') in 1 generateJson call", async () => {
    const { client, generateText, generateJson } = makeMockClient();
    const pageSummary: RefindPageElement[] = [
      {
        locators: [
          { kind: "testid", value: "cancel-btn" },
          { kind: "aria", value: "Cancel" },
        ],
        label: "Cancel",
        role: "button",
        tag: "button",
      },
      {
        locators: [
          { kind: "testid", value: "save-changes-btn" },
          { kind: "aria", value: "Save Changes" },
        ],
        label: "Save Changes",
        role: "button",
        tag: "button",
      },
      {
        locators: [
          { kind: "testid", value: "delete-btn" },
          { kind: "aria", value: "Delete" },
        ],
        label: "Delete",
        role: "button",
        tag: "button",
      },
    ];

    generateJson.mockResolvedValueOnce({
      locators: [
        { kind: "testid", value: "save-changes-btn" },
        { kind: "aria", value: "Save Changes" },
      ],
      why: "Button 'Save' was renamed to 'Save Changes' with matching button role.",
    });

    const result = await refindElement(
      {
        step: {
          action: "click",
          locators: [
            { kind: "testid", value: "save-btn" },
            { kind: "aria", value: "Save" },
          ],
          label: "Save",
          role: "button",
        },
        pageSummary,
      },
      client,
    );

    expect(result).toEqual({
      locators: [
        { kind: "testid", value: "save-changes-btn" },
        { kind: "aria", value: "Save Changes" },
      ],
      why: "Button 'Save' was renamed to 'Save Changes' with matching button role.",
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(generateJson).toHaveBeenCalledTimes(1);

    const [prompt, schema] = generateJson.mock.calls[0];
    expect(schema).toBe(RefindResultSchema);
    expect(prompt).toContain("click");
    expect(prompt).toContain("save-btn");
    expect(prompt).toContain("Save");
    expect(prompt).toContain("button");
    expect(prompt).toContain("save-changes-btn");
    expect(prompt).toContain("Save Changes");
    expect(prompt).toMatch(/same role/i);
    expect(prompt).toMatch(/Delete.*Save|destructive/i);
    expect(prompt).toContain("locators: null");
  });

  it("(3) relocates a moved field with updated testid/css in another section (structured and string pageSummary)", async () => {
    const { client, generateJson } = makeMockClient();

    const pageElements: RefindPageElement[] = [
      {
        locators: [
          { kind: "testid", value: "billing-section-email" },
          { kind: "css", value: "section.billing-details input[name='billingEmail']" },
        ],
        label: "Billing Email",
        role: "textbox",
        tag: "input",
      },
      {
        locators: [
          { kind: "testid", value: "shipping-section-notes" },
          { kind: "css", value: "section.shipping-details textarea[name='notes']" },
        ],
        label: "Delivery Notes",
        role: "textbox",
        tag: "textarea",
      },
    ];

    generateJson.mockResolvedValueOnce({
      locators: [
        { kind: "testid", value: "billing-section-email" },
        { kind: "css", value: "section.billing-details input[name='billingEmail']" },
      ],
      why: "The Billing Email field moved into section.billing-details with updated testid and css selector.",
    });

    const structuredResult = await refindElement(
      {
        step: {
          action: "fill",
          locators: [
            { kind: "testid", value: "customer-info-email" },
            { kind: "css", value: "section.customer-info input[name='email']" },
          ],
          label: "Billing Email",
          role: "textbox",
        },
        pageSummary: pageElements,
      },
      client,
    );

    expect(structuredResult).toEqual({
      locators: [
        { kind: "testid", value: "billing-section-email" },
        { kind: "css", value: "section.billing-details input[name='billingEmail']" },
      ],
      why: "The Billing Email field moved into section.billing-details with updated testid and css selector.",
    });

    // Also supports string pageSummary when returned locator values appear in it
    const textPageSummary = [
      "Form section: Billing Details",
      '- input[role="textbox"] label="Billing Email" testid="billing-section-email" css="section.billing-details input[name=\'billingEmail\']"',
    ].join("\n");

    generateJson.mockResolvedValueOnce({
      locators: [{ kind: "testid", value: "billing-section-email" }],
      why: "Matched Billing Email textbox in the Billing Details section.",
    });

    const stringResult = await refindElement(
      {
        step: {
          action: "fill",
          locators: [{ kind: "testid", value: "customer-info-email" }],
          label: "Billing Email",
          role: "textbox",
        },
        pageSummary: textPageSummary,
      },
      client,
    );

    expect(stringResult).toEqual({
      locators: [{ kind: "testid", value: "billing-section-email" }],
      why: "Matched Billing Email textbox in the Billing Details section.",
    });
  });

  it("(4) returns { locators: null, why } when no element matches", async () => {
    const { client, generateJson } = makeMockClient();
    const pageSummary: RefindPageElement[] = [
      {
        locators: [{ kind: "aria", value: "Back to Dashboard" }],
        label: "Back to Dashboard",
        role: "link",
        tag: "a",
      },
    ];

    generateJson.mockResolvedValueOnce({
      locators: null,
      why: "No button matching 'Export CSV' is present on the page.",
    });

    const result = await refindElement(
      {
        step: {
          action: "click",
          locators: [{ kind: "aria", value: "Export CSV" }],
          label: "Export CSV",
          role: "button",
        },
        pageSummary,
      },
      client,
    );

    expect(result).toEqual({
      locators: null,
      why: "No button matching 'Export CSV' is present on the page.",
    });

    // Empty locator array from model also normalizes to locators: null
    generateJson.mockResolvedValueOnce({
      locators: [],
      why: "No matching element found.",
    });

    await expect(
      refindElement(
        {
          step: {
            action: "click",
            locators: [{ kind: "aria", value: "Export CSV" }],
            label: "Export CSV",
            role: "button",
          },
          pageSummary,
        },
        client,
      ),
    ).resolves.toEqual({
      locators: null,
      why: "No matching element found.",
    });
  });

  it("(5) rejects hallucinated locators, cross-element combinations, and role conflicts to { locators: null, why }", async () => {
    const { client, generateJson } = makeMockClient();
    const pageSummary: RefindPageElement[] = [
      {
        locators: [
          { kind: "testid", value: "delete-btn" },
          { kind: "aria", value: "Delete" },
        ],
        label: "Delete",
        role: "link",
        tag: "a",
      },
      {
        locators: [
          { kind: "testid", value: "cancel-btn" },
          { kind: "aria", value: "Cancel" },
        ],
        label: "Cancel",
        role: "button",
        tag: "button",
      },
    ];

    const saveStep = {
      action: "click" as const,
      locators: [{ kind: "testid" as const, value: "save-btn" }],
      label: "Save",
      role: "button",
    };

    // Case A: Model hallucinates a locator absent from pageSummary
    generateJson.mockResolvedValueOnce({
      locators: [{ kind: "testid", value: "invented-save-btn" }],
      why: "Matched save button.",
    });
    const hallucinated = await refindElement({ step: saveStep, pageSummary }, client);
    expect(hallucinated.locators).toBeNull();
    expect(hallucinated.why.length).toBeGreaterThan(0);

    // Case B: Model returns Delete lookalike with conflicting role ('link' vs 'button')
    generateJson.mockResolvedValueOnce({
      locators: [{ kind: "testid", value: "delete-btn" }],
      why: "Matched Delete action.",
    });
    const roleConflict = await refindElement({ step: saveStep, pageSummary }, client);
    expect(roleConflict.locators).toBeNull();
    expect(roleConflict.why.length).toBeGreaterThan(0);

    // Case C: Model mixes locators from two different elements
    generateJson.mockResolvedValueOnce({
      locators: [
        { kind: "testid", value: "delete-btn" },
        { kind: "aria", value: "Cancel" },
      ],
      why: "Combined locators.",
    });
    const mixedElements = await refindElement({ step: saveStep, pageSummary }, client);
    expect(mixedElements.locators).toBeNull();
    expect(mixedElements.why.length).toBeGreaterThan(0);

    // Case D: Hallucinated locator with string pageSummary
    generateJson.mockResolvedValueOnce({
      locators: [{ kind: "testid", value: "save-btn-missing" }],
      why: "Matched save button.",
    });
    const missingInString = await refindElement(
      {
        step: saveStep,
        pageSummary: 'Toolbar buttons: testid="delete-btn" label="Delete", testid="cancel-btn" label="Cancel"',
      },
      client,
    );
    expect(missingInString.locators).toBeNull();
    expect(missingInString.why.length).toBeGreaterThan(0);
  });

  it("propagates schema validation errors when Gemini output fails RefindResultSchema", async () => {
    const sdkInvalid: GeminiSdk = {
      models: {
        generateContent: vi.fn(async () => ({
          text: JSON.stringify({
            locators: [{ kind: "xpath", value: "//button[@id='save']" }],
            why: "Used unsupported locator kind.",
          }),
        })),
      },
    };
    const client = createGeminiClient({ sdk: sdkInvalid });

    await expect(
      refindElement(
        {
          step: {
            action: "click",
            locators: [{ kind: "testid", value: "save-btn" }],
            label: "Save",
            role: "button",
          },
          pageSummary: [
            {
              locators: [{ kind: "testid", value: "save-changes-btn" }],
              label: "Save Changes",
              role: "button",
            },
          ],
        },
        client,
      ),
    ).rejects.toThrow(/schema validation/i);
  });
});

describe.skipIf(!process.env.GOOGLE_CLOUD_PROJECT)("refindElement (live Gemini)", () => {
  it("relocates a renamed button and refuses a dangerous Delete lookalike using Vertex AI ADC", async () => {
    const prevUseVertex = process.env.GOOGLE_GENAI_USE_VERTEXAI;
    process.env.GOOGLE_GENAI_USE_VERTEXAI ??= "true";
    try {
      const client = createGeminiClient();

      const renamed = await refindElement(
        {
          step: {
            action: "click",
            locators: [
              { kind: "testid", value: "save-btn" },
              { kind: "aria", value: "Save" },
            ],
            label: "Save",
            role: "button",
          },
          pageSummary: [
            {
              locators: [
                { kind: "testid", value: "cancel-btn" },
                { kind: "aria", value: "Cancel" },
              ],
              label: "Cancel",
              role: "button",
              tag: "button",
            },
            {
              locators: [
                { kind: "testid", value: "save-changes-btn" },
                { kind: "aria", value: "Save Changes" },
              ],
              label: "Save Changes",
              role: "button",
              tag: "button",
            },
            {
              locators: [
                { kind: "testid", value: "delete-btn" },
                { kind: "aria", value: "Delete" },
              ],
              label: "Delete",
              role: "button",
              tag: "button",
            },
          ],
        },
        client,
      );

      expect(RefindResultSchema.safeParse(renamed).success).toBe(true);
      expect(renamed.locators).not.toBeNull();
      expect(
        renamed.locators?.some(
          (loc) => loc.value === "save-changes-btn" || loc.value === "Save Changes",
        ),
      ).toBe(true);

      const lookalike = await refindElement(
        {
          step: {
            action: "click",
            locators: [
              { kind: "testid", value: "save-btn" },
              { kind: "aria", value: "Save" },
            ],
            label: "Save",
            role: "button",
          },
          pageSummary: [
            {
              locators: [
                { kind: "testid", value: "delete-btn" },
                { kind: "aria", value: "Delete" },
              ],
              label: "Delete",
              role: "button",
              tag: "button",
            },
            {
              locators: [
                { kind: "testid", value: "cancel-btn" },
                { kind: "aria", value: "Cancel" },
              ],
              label: "Cancel",
              role: "button",
              tag: "button",
            },
          ],
        },
        client,
      );

      expect(RefindResultSchema.safeParse(lookalike).success).toBe(true);
      expect(lookalike.locators).toBeNull();
    } finally {
      if (prevUseVertex === undefined) {
        delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
      } else {
        process.env.GOOGLE_GENAI_USE_VERTEXAI = prevUseVertex;
      }
    }
  }, 30_000);
});
