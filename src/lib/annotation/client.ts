import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";

let instance: Anthropic | undefined;

/** One client, with the base URL overridable so tests point it at a mock. */
export function anthropic(): Anthropic {
  if (!instance) {
    const e = env();
    instance = new Anthropic({ apiKey: e.ANTHROPIC_API_KEY ?? "missing", baseURL: e.ANTHROPIC_BASE_URL, maxRetries: 2, timeout: 120_000 });
  }
  return instance;
}

/** Thinking and effort settings differ by model: Opus 5 and Sonnet 5 take adaptive thinking with an effort level; Haiku 4.5 takes neither. */
export function thinkingParams(model: string): { thinking?: { type: "adaptive" }; output_config?: { effort: "low" } } {
  if (model === "claude-haiku-4-5") return {};
  return { thinking: { type: "adaptive" }, output_config: { effort: "low" } };
}
