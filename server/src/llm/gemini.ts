/**
 * Gemini client wrapper (`@google/genai`).
 *
 * Supports two authentication modes:
 * 1. API key mode (when `GEMINI_API_KEY` or `options.apiKey` is set):
 *      GEMINI_API_KEY=<your-api-key>
 * 2. Vertex AI mode with Application Default Credentials (ADC):
 *      GOOGLE_GENAI_USE_VERTEXAI=true
 *      GOOGLE_CLOUD_PROJECT=genaihack26ath-52
 *      GOOGLE_CLOUD_LOCATION=global
 *
 * Optional environment variables:
 *   GEMINI_MODEL=gemini-3-flash-preview
 *
 * Never log or print the API key.
 *
 * Usage example:
 * ```ts
 * import { FindingSchema } from "@gen/shared/schema.ts";
 * import { createGeminiClient } from "./llm/gemini.ts";
 *
 * const gemini = createGeminiClient();
 *
 * // Plain text generation
 * const summary = await gemini.generateText("Summarize this workflow trace.");
 *
 * // Structured JSON generation validated with a Zod schema
 * const finding = await gemini.generateJson(
 *   "Return a Finding JSON object for this trace.",
 *   FindingSchema,
 * );
 * ```
 */

import { GoogleGenAI } from "@google/genai";

export const DEFAULT_GEMINI_MODEL = "gemini-3-flash-preview";
export const DEFAULT_GCP_PROJECT = "genaihack26ath-52";
export const DEFAULT_GCP_LOCATION = "global";

export type ZodLikeSchema<T> = {
  safeParse(
    data: unknown,
  ):
    | { success: true; data: T }
    | {
        success: false;
        error: {
          message?: string;
          issues?: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
        };
      };
};

export type GeminiSdk = {
  models: {
    generateContent(params: {
      model: string;
      contents: string;
      config?: {
        responseMimeType?: string;
        responseSchema?: unknown;
        thinkingConfig?: { thinkingBudget?: number };
        abortSignal?: AbortSignal;
      };
    }): Promise<{ text?: string }>;
  };
};

export type GeminiClientOptions = {
  model?: string;
  project?: string;
  location?: string;
  sdk?: GeminiSdk;
  apiKey?: string;
  thinkingBudget?: number;
  responseSchema?: unknown;
  timeoutMs?: number;
};

export type GeminiClient = {
  generateText(prompt: string): Promise<string>;
  generateJson<T>(prompt: string, schema: ZodLikeSchema<T>): Promise<T>;
};

function stripJsonCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      new Error(`Gemini request timed out after ${timeoutMs} ms`),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new Error(`Gemini request timed out after ${timeoutMs} ms`));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export function createGeminiClient(options?: GeminiClientOptions): GeminiClient {
  const apiKey = options?.apiKey || process.env.GEMINI_API_KEY;
  if (!options?.sdk && !apiKey && process.env.GOOGLE_GENAI_USE_VERTEXAI !== "true") {
    throw new Error(
      "Missing Gemini credentials: set GEMINI_API_KEY for API key mode, or set GOOGLE_GENAI_USE_VERTEXAI=true (with GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION) for Vertex AI ADC mode.",
    );
  }

  const model = options?.model || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const project = options?.project || process.env.GOOGLE_CLOUD_PROJECT || DEFAULT_GCP_PROJECT;
  const location = options?.location || process.env.GOOGLE_CLOUD_LOCATION || DEFAULT_GCP_LOCATION;

  const sdk: GeminiSdk =
    options?.sdk ??
    (apiKey
      ? new GoogleGenAI({ apiKey })
      : new GoogleGenAI({ vertexai: true, project, location }));

  return {
    async generateText(prompt: string): Promise<string> {
      const startedAt = Date.now();
      try {
        const response = await sdk.models.generateContent({
          model,
          contents: prompt,
        });
        if (!response.text || response.text.trim().length === 0) {
          throw new Error("Gemini returned an empty text response.");
        }
        console.log(`[gemini] model=${model} kind=text ms=${Date.now() - startedAt} ok`);
        return response.text;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[gemini] model=${model} kind=text ms=${Date.now() - startedAt} error=${msg}`);
        throw err;
      }
    },

    async generateJson<T>(prompt: string, schema: ZodLikeSchema<T>): Promise<T> {
      const startedAt = Date.now();
      try {
        const config: {
          responseMimeType?: string;
          responseSchema?: unknown;
          thinkingConfig?: { thinkingBudget?: number };
          abortSignal?: AbortSignal;
        } = { responseMimeType: "application/json" };
        if (options?.thinkingBudget !== undefined) {
          config.thinkingConfig = { thinkingBudget: options.thinkingBudget };
        }
        if (options?.responseSchema !== undefined) {
          config.responseSchema = options.responseSchema;
        }
        let signal: AbortSignal | undefined;
        if (options?.timeoutMs !== undefined) {
          if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
            throw new Error(`Gemini request timed out after ${options.timeoutMs} ms`);
          }
          signal = AbortSignal.timeout(options.timeoutMs);
          config.abortSignal = signal;
        }
        const generatePromise = sdk.models.generateContent({
          model,
          contents: prompt,
          config,
        });
        const response = signal
          ? await raceWithAbort(generatePromise, signal, options!.timeoutMs!)
          : await generatePromise;
        if (!response.text || response.text.trim().length === 0) {
          throw new Error("Gemini returned an empty JSON response.");
        }

        const rawJson = stripJsonCodeFences(response.text);
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawJson);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`Gemini returned malformed JSON: ${message}`);
        }

        const result = schema.safeParse(parsed);
        if (!result.success) {
          const details =
            result.error.issues && result.error.issues.length > 0
              ? result.error.issues
                  .map((issue) => `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`)
                  .join("; ")
              : (result.error.message ?? "Schema validation failed");
          throw new Error(`Gemini JSON response failed schema validation: ${details}`);
        }

        console.log(`[gemini] model=${model} kind=json ms=${Date.now() - startedAt} ok`);
        return result.data;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[gemini] model=${model} kind=json ms=${Date.now() - startedAt} error=${msg}`);
        throw err;
      }
    },
  };
}
