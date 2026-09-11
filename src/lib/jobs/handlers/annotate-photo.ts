import { anthropic } from "@/lib/annotation/client";
import { annotationGates, optOutReason } from "@/lib/annotation/eligibility";
import { buildRequest, loadItem } from "@/lib/annotation/request";
import { applyAnnotation, recordFailure } from "@/lib/annotation/apply";
import { permittedNames } from "@/lib/people/gates";
import type { AnnotatePhotoJob } from "../queues";

/**
 * Send one item to the helper and store the structured record. Logs only ids, model, token counts and the stop
 * reason, never prompts or responses. Refusals are recorded as a reason code and the item is left alone.
 */
export async function annotatePhoto(job: AnnotatePhotoJob): Promise<void> {
  const gates = await annotationGates();
  if (!gates.active) return;
  const item = await loadItem(job.photoId);
  if (!item || item.status !== "READY") return;
  const reason = await optOutReason(item.id);
  if (reason) return;
  // Names go to the helper only for confirmed people whose indexing is on and who are not minors; pets always.
  const request = await buildRequest(item, gates.model, await permittedNames(item.id));
  try {
    const response = await anthropic().messages.parse(request);
    const usage = response.usage;
    console.log(`[annotate] ${item.id} model=${response.model} stop=${response.stop_reason} in=${usage.input_tokens} cached=${usage.cache_read_input_tokens ?? 0} out=${usage.output_tokens}`);
    if (response.stop_reason === "refusal") {
      await recordFailure(item.id, `refusal:${response.stop_details?.category ?? "unspecified"}`);
      return;
    }
    if (response.stop_reason === "max_tokens" || !response.parsed_output) {
      await recordFailure(item.id, response.stop_reason === "max_tokens" ? "max_tokens" : "invalid_output");
      return;
    }
    await applyAnnotation(item.id, response.model, response.parsed_output, { content: response.content, usage: response.usage, stop_reason: response.stop_reason });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[annotate] ${item.id} failed: ${message.slice(0, 200)}`);
    throw err;
  }
}
