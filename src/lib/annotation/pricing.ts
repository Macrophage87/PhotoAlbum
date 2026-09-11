/**
 * Per-model prices for the backfill estimate. Checked against Anthropic's published rates on the date below;
 * the admin page shows that date next to the figure so a stale table is visible rather than silently wrong.
 */
export const pricesAsOf = "2026-06-24";

export const PRICES: Record<string, { inputPerMTok: number; outputPerMTok: number; cacheReadFactor: number; cacheMinTokens: number }> = {
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25, cacheReadFactor: 0.1, cacheMinTokens: 512 },
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10, cacheReadFactor: 0.1, cacheMinTokens: 1024 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5, cacheReadFactor: 0.1, cacheMinTokens: 4096 },
};

/** Rough per-item token shape: a 1600px image, the cached instructions, a structured answer. */
export const TOKENS_PER_PHOTO = { image: 2500, instructions: 1000, output: 400 };
export const VIDEO_FRAME_MULTIPLIER = 3.5;
export const BATCH_DISCOUNT = 0.5;

export type Estimate = { items: number; inputTokens: number; outputTokens: number; usd: number; approximate: true; pricesAsOf: string; model: string };

/** Estimate a run. Instructions bill at the cache-read rate when the block can cache on this model, full price otherwise. */
export function estimateCost(model: string, counts: { photos: number; videos: number }, opts: { batch: boolean }): Estimate {
  const price = PRICES[model] ?? PRICES["claude-opus-5"];
  const items = counts.photos + counts.videos;
  const imageTokens = counts.photos * TOKENS_PER_PHOTO.image + counts.videos * TOKENS_PER_PHOTO.image * VIDEO_FRAME_MULTIPLIER;
  const cached = TOKENS_PER_PHOTO.instructions >= price.cacheMinTokens;
  const instructionTokens = items * TOKENS_PER_PHOTO.instructions;
  const outputTokens = items * TOKENS_PER_PHOTO.output;
  const usdInput = (imageTokens / 1e6) * price.inputPerMTok + (instructionTokens / 1e6) * price.inputPerMTok * (cached ? price.cacheReadFactor : 1);
  const usdOutput = (outputTokens / 1e6) * price.outputPerMTok;
  const usd = (usdInput + usdOutput) * (opts.batch ? BATCH_DISCOUNT : 1);
  return { items, inputTokens: Math.round(imageTokens + instructionTokens), outputTokens, usd: Math.round(usd * 100) / 100, approximate: true, pricesAsOf, model };
}

export type Spend = { items: number; inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number; usd: number; model: string; pricesAsOf: string };

/** Writing the instruction block into the five-minute cache costs this much more than a plain input token. */
export const CACHE_WRITE_FACTOR = 1.25;

/**
 * Real spend from recorded usage, each row at the price of the model that answered it: single requests at list
 * price, batch results at the batch discount. `input` is the API's input_tokens, which already excludes cache reads
 * and cache writes; those are billed at their own factors.
 */
export function actualSpend(fallbackModel: string, rows: { model?: string | null; input: number; cacheRead: number; cacheWrite?: number; output: number; batched: boolean }[]): Spend {
  let usd = 0, inputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, outputTokens = 0;
  for (const r of rows) {
    const price = PRICES[r.model ?? ""] ?? PRICES[fallbackModel] ?? PRICES["claude-opus-5"];
    const factor = r.batched ? BATCH_DISCOUNT : 1;
    usd += factor * ((r.input * price.inputPerMTok + r.cacheRead * price.inputPerMTok * price.cacheReadFactor + (r.cacheWrite ?? 0) * price.inputPerMTok * CACHE_WRITE_FACTOR + r.output * price.outputPerMTok) / 1_000_000);
    inputTokens += r.input;
    cacheReadTokens += r.cacheRead;
    cacheWriteTokens += r.cacheWrite ?? 0;
    outputTokens += r.output;
  }
  return { items: rows.length, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, usd: Math.round(usd * 100) / 100, model: fallbackModel, pricesAsOf };
}
