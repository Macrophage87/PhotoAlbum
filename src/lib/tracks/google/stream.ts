import { createReadStream } from "node:fs";
import chain from "stream-chain";
import { parser } from "stream-json";
import { pick } from "stream-json/filters/pick.js";
import { streamArray } from "stream-json/streamers/stream-array.js";

/** Iterate the elements of a (possibly huge) JSON array at `path` ("" for a top-level array). */
export async function* streamJsonArray(filePath: string, path: string): AsyncGenerator<unknown> {
  const stages: unknown[] = [createReadStream(filePath), parser()];
  if (path) stages.push(pick({ filter: path }));
  stages.push(streamArray());
  const pipeline = chain(stages as never);
  for await (const item of pipeline as AsyncIterable<{ key: number; value: unknown }>) yield item.value;
}
