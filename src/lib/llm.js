// Wraps WebLLM: a small instruction-tuned model running in-browser via WebGPU. This is what
// turns retrieved snippets into an actual written answer instead of a ranked list of quotes.

import { CreateMLCEngine, prebuiltAppConfig } from "@mlc-ai/web-llm";
import { trimRepetition } from "./repetition.js";
import { hasWebGPU, WEBGPU_UNAVAILABLE_MESSAGE } from "./gpu.js";

// Qwen3-0.6B: roughly a third of the download of the previous Qwen2.5-1.5B, and a newer model
// family. Thinking mode is disabled on every request (see NO_THINKING) so JSON planning calls
// return JSON immediately instead of a reasoning preamble.
export const MODEL_ID = "Qwen3-0.6B-q4f16_1-MLC";
const NO_THINKING = { enable_thinking: false };

// WebLLM's default "cache" backend stores weight shards with Cache.add(), which fails with
// "Cache.add() encountered a network error" when a large shard download is interrupted or
// redirected (Hugging Face serves weights through a CDN redirect). IndexedDB stores the fetched
// bytes directly and avoids that failure mode.
const APP_CONFIG = { ...prebuiltAppConfig, cacheBackend: "indexeddb" };

let enginePromise = null;

// WebLLM has no WASM (or any other) fallback for the LLM itself -- unlike the embedder, there is
// no slower-but-working path here. Checking navigator.gpu.requestAdapter() up front turns an
// otherwise-cryptic failure several layers deep inside WebLLM's WASM/WebGPU backend selection
// (e.g. "no available backend found") into one clear, actionable message. This check is the same
// on Windows, macOS, and Linux Chrome -- it's a per-machine GPU/driver/policy fact, not a
// per-platform one.
export async function loadLLM(onProgress) {
  if (!enginePromise) {
    enginePromise = (async () => {
      if (!(await hasWebGPU())) {
        throw new Error(WEBGPU_UNAVAILABLE_MESSAGE);
      }
      return CreateMLCEngine(MODEL_ID, {
        appConfig: APP_CONFIG,
        initProgressCallback: onProgress,
      });
    })().catch((err) => {
      // Don't cache a failed load: a transient issue (driver update, flag flip, retrying after
      // closing other GPU-heavy tabs) should be retry-able on the next "Load models" click
      // instead of permanently replaying the first failure for the rest of the browser session.
      enginePromise = null;
      throw err;
    });
  }
  return enginePromise;
}

// Non-streaming call used for the agent's own internal decisions (query planning, sufficiency
// checks) -- those responses are short and never shown to the user directly, so there's nothing
// to stream.
export async function chatJSON(messages) {
  const engine = await loadLLM();
  const reply = await engine.chat.completions.create({
    messages,
    temperature: 0.2,
    response_format: { type: "json_object" },
    extra_body: NO_THINKING,
  });
  return reply.choices[0].message.content;
}

// Streaming call used for the final answer, so the popup can render tokens as they arrive
// instead of staring at a spinner for several seconds.
export async function chatStream(messages, onToken) {
  const engine = await loadLLM();
  const stream = await engine.chat.completions.create({
    messages,
    temperature: 0.3,
    // A 0.6B model easily loops on list-like pages; penalize repeats and cap the length.
    frequency_penalty: 0.6,
    repetition_penalty: 1.1,
    max_tokens: 600,
    stream: true,
    extra_body: NO_THINKING,
  });
  let full = "";
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content || "";
    if (!delta) continue;
    full += delta;
    const { text, looped } = trimRepetition(full);
    if (looped) {
      engine.interruptGenerate();
      full = text;
      onToken("", full);
      break;
    }
    onToken(delta, full);
  }
  return full;
}
