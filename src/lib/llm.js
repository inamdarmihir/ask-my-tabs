// Wraps WebLLM: a small instruction-tuned model running in-browser via WebGPU. This is what
// turns retrieved snippets into an actual written answer instead of a ranked list of quotes.

import { CreateMLCEngine } from "@mlc-ai/web-llm";

export const MODEL_ID = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";

let enginePromise = null;

export async function loadLLM(onProgress) {
  if (!enginePromise) {
    enginePromise = CreateMLCEngine(MODEL_ID, {
      initProgressCallback: onProgress,
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
    stream: true,
  });
  let full = "";
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content || "";
    if (delta) {
      full += delta;
      onToken(delta, full);
    }
  }
  return full;
}
