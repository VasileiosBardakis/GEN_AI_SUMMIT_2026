import { afterEach, describe, expect, it, vi } from "vitest";
import { FindingSchema, LocatorSchema } from "@gen/shared/schema.ts";
import {
  createGeminiClient,
  DEFAULT_GCP_LOCATION,
  DEFAULT_GCP_PROJECT,
  DEFAULT_GEMINI_MODEL,
  type GeminiSdk,
} from "../src/llm/gemini.ts";

const { googleGenAiCtorSpy, mockGenerateContent } = vi.hoisted(() => {
  const mockGenerateContent = vi.fn<GeminiSdk["models"]["generateContent"]>(async () => ({
    text: "mocked sdk response",
  }));
  const googleGenAiCtorSpy = vi.fn();
  return { googleGenAiCtorSpy, mockGenerateContent };
});

vi.mock("@google/genai", () => {
  class MockGoogleGenAI {
    models = {
      generateContent: mockGenerateContent,
    };
    constructor(options: unknown) {
      googleGenAiCtorSpy(options);
    }
  }
  return { GoogleGenAI: MockGoogleGenAI };
});

function makeFakeSdk(text?: string) {
  const generateContent = vi.fn<GeminiSdk["models"]["generateContent"]>(async () => ({
    text,
  }));
  const sdk: GeminiSdk = {
    models: {
      generateContent,
    },
  };
  return { sdk, generateContent };
}

describe("createGeminiClient", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    googleGenAiCtorSpy.mockClear();
    mockGenerateContent.mockClear();
    for (const key of [
      "GEMINI_MODEL",
      "GOOGLE_GENAI_USE_VERTEXAI",
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_CLOUD_LOCATION",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
    ]) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  it("exports expected Vertex AI defaults", () => {
    expect(DEFAULT_GEMINI_MODEL).toBe("gemini-2.5-flash");
    expect(DEFAULT_GCP_PROJECT).toBe("genaihack26ath-52");
    expect(DEFAULT_GCP_LOCATION).toBe("global");
  });

  it("generateText returns model text and resolves model priority (options.model > GEMINI_MODEL > DEFAULT_GEMINI_MODEL)", async () => {
    delete process.env.GEMINI_MODEL;

    // 1. Default model when neither options.model nor GEMINI_MODEL is set
    const fake1 = makeFakeSdk("default model response");
    const clientDefault = createGeminiClient({ sdk: fake1.sdk });
    await expect(clientDefault.generateText("Summarize trace")).resolves.toBe(
      "default model response",
    );
    expect(fake1.generateContent).toHaveBeenCalledWith({
      model: DEFAULT_GEMINI_MODEL,
      contents: "Summarize trace",
    });

    // 2. process.env.GEMINI_MODEL overrides DEFAULT_GEMINI_MODEL
    process.env.GEMINI_MODEL = "gemini-2.5-pro";
    const fake2 = makeFakeSdk("env model response");
    const clientEnv = createGeminiClient({ sdk: fake2.sdk });
    await expect(clientEnv.generateText("Analyze trace")).resolves.toBe("env model response");
    expect(fake2.generateContent).toHaveBeenCalledWith({
      model: "gemini-2.5-pro",
      contents: "Analyze trace",
    });

    // 3. options.model overrides process.env.GEMINI_MODEL
    const fake3 = makeFakeSdk("options model response");
    const clientOpt = createGeminiClient({
      model: "gemini-2.0-flash-lite",
      sdk: fake3.sdk,
    });
    await expect(clientOpt.generateText("Classify trace")).resolves.toBe("options model response");
    expect(fake3.generateContent).toHaveBeenCalledWith({
      model: "gemini-2.0-flash-lite",
      contents: "Classify trace",
    });
  });

  it("generateText throws when response.text is empty or undefined", async () => {
    const emptyFake = makeFakeSdk("");
    const emptyClient = createGeminiClient({ sdk: emptyFake.sdk });
    await expect(emptyClient.generateText("prompt")).rejects.toThrow(/empty/i);

    const undefinedFake = makeFakeSdk(undefined);
    const undefinedClient = createGeminiClient({ sdk: undefinedFake.sdk });
    await expect(undefinedClient.generateText("prompt")).rejects.toThrow(/empty/i);
  });

  it("generateJson requests application/json, strips optional markdown fences, and validates with a Zod schema", async () => {
    const validFinding = {
      id: "finding-1",
      workflowId: "wf-reply",
      verdict: "rung1" as const,
      title: "Automate repetitive reply",
      why: "Observed 3 identical reply sequences",
      whyNotNext: "UI locators are stable; full browser agent is unnecessary",
      stats: {
        repetitions: 3,
        minutesPerWeek: 12,
        stability: 0.95,
      },
    };

    const { sdk, generateContent } = makeFakeSdk(
      `\`\`\`json\n${JSON.stringify(validFinding, null, 2)}\n\`\`\``,
    );
    const client = createGeminiClient({ sdk });

    const result = await client.generateJson("Produce a Finding", FindingSchema);
    expect(result).toEqual(validFinding);
    expect(generateContent).toHaveBeenCalledWith({
      model: DEFAULT_GEMINI_MODEL,
      contents: "Produce a Finding",
      config: { responseMimeType: "application/json" },
    });
  });

  it("generateJson throws a clear error on malformed JSON", async () => {
    const { sdk } = makeFakeSdk("{not valid json");
    const client = createGeminiClient({ sdk });

    await expect(client.generateJson("Return a locator", LocatorSchema)).rejects.toThrow(
      /malformed JSON/i,
    );
  });

  it("generateJson throws a clear error when JSON violates the Zod schema", async () => {
    const invalidLocator = JSON.stringify({
      kind: "invalid-locator-kind",
      value: 123,
    });
    const { sdk } = makeFakeSdk(invalidLocator);
    const client = createGeminiClient({ sdk });

    await expect(client.generateJson("Return a locator", LocatorSchema)).rejects.toThrow(
      /schema validation.*kind/i,
    );
  });

  it("builds SDK in API key mode when GEMINI_API_KEY is set and options.apiKey overrides env", async () => {
    delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
    process.env.GEMINI_API_KEY = "env-gemini-key";

    const envClient = createGeminiClient();
    expect(googleGenAiCtorSpy).toHaveBeenCalledTimes(1);
    expect(googleGenAiCtorSpy).toHaveBeenLastCalledWith({ apiKey: "env-gemini-key" });
    await expect(envClient.generateText("ping")).resolves.toBe("mocked sdk response");

    // options.apiKey overrides both GEMINI_API_KEY and GOOGLE_GENAI_USE_VERTEXAI
    process.env.GOOGLE_GENAI_USE_VERTEXAI = "true";
    const keyClient = createGeminiClient({ apiKey: "options-override-key" });
    expect(googleGenAiCtorSpy).toHaveBeenCalledTimes(2);
    expect(googleGenAiCtorSpy).toHaveBeenLastCalledWith({ apiKey: "options-override-key" });

    // Key never appears in any error message thrown by the client
    mockGenerateContent.mockResolvedValueOnce({ text: "" });
    let errText = "";
    try {
      await keyClient.generateText("ping");
    } catch (err) {
      errText = (err as Error).message;
    }
    expect(errText).toMatch(/empty/i);
    expect(errText).not.toContain("options-override-key");
    expect(errText).not.toContain("env-gemini-key");
  });

  it("builds SDK in Vertex AI ADC mode when only Vertex variables are set", () => {
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLE_GENAI_USE_VERTEXAI = "true";
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_LOCATION;

    createGeminiClient();
    expect(googleGenAiCtorSpy).toHaveBeenCalledTimes(1);
    expect(googleGenAiCtorSpy).toHaveBeenLastCalledWith({
      vertexai: true,
      project: DEFAULT_GCP_PROJECT,
      location: DEFAULT_GCP_LOCATION,
    });

    process.env.GOOGLE_CLOUD_PROJECT = "custom-proj";
    process.env.GOOGLE_CLOUD_LOCATION = "us-central1";
    createGeminiClient();
    expect(googleGenAiCtorSpy).toHaveBeenCalledTimes(2);
    expect(googleGenAiCtorSpy).toHaveBeenLastCalledWith({
      vertexai: true,
      project: "custom-proj",
      location: "us-central1",
    });

    createGeminiClient({ project: "opt-proj", location: "europe-west1" });
    expect(googleGenAiCtorSpy).toHaveBeenCalledTimes(3);
    expect(googleGenAiCtorSpy).toHaveBeenLastCalledWith({
      vertexai: true,
      project: "opt-proj",
      location: "europe-west1",
    });
  });

  it("throws a clear error naming the required variables when neither sign-in mode is configured and never leaks secrets", () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
    process.env.GOOGLE_API_KEY = "unused-google-api-key-secret";

    let caught: Error | undefined;
    try {
      createGeminiClient();
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).toContain("GEMINI_API_KEY");
    expect(caught?.message).toContain("GOOGLE_GENAI_USE_VERTEXAI");
    expect(caught?.message).toContain("GOOGLE_CLOUD_PROJECT");
    expect(caught?.message).toContain("GOOGLE_CLOUD_LOCATION");
    expect(caught?.message).not.toContain("unused-google-api-key-secret");
    expect(googleGenAiCtorSpy).not.toHaveBeenCalled();
  });
});
