// API-based LLM client. Supports OpenAI, Groq (identical wire format to OpenAI), and Gemini.
// The function signatures are intentionally identical to the WebLLM exports in src/lib/llm.js
// so src/offscreen.js can swap between them with a single conditional -- no other code needs
// to know which backend is active.
//
// All requests go directly from the browser to the provider; the extension does not proxy them.
// This is documented in the privacy policy: the user's question and retrieved snippets are
// sent to whichever provider they configured, under their own API key.

import { OPENAI_COMPATIBLE_PROVIDERS } from "./config.js";

// Temperature constants match the WebLLM path in llm.js for consistency: lower for the
// agent's internal JSON decisions, slightly higher for the user-facing streamed answer.
const JSON_TEMPERATURE = 0.2;
const STREAM_TEMPERATURE = 0.3;

// ─── OpenAI-compatible (OpenAI, Groq) ────────────────────────────────────────

async function openAIRequest(messages, { apiKey, model, baseUrl, stream = false, responseFormat }) {
  const send = (withTemperature) =>
    fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        ...(withTemperature ? { temperature: stream ? STREAM_TEMPERATURE : JSON_TEMPERATURE } : {}),
        stream,
        ...(responseFormat ? { response_format: responseFormat } : {}),
      }),
    });

  let res = await send(true);
  if (!res.ok) {
    let text = await res.text().catch(() => res.statusText);
    // Some newer models only accept their default temperature and reject the parameter with a
    // 400. Retry once without it rather than making those models unusable.
    if (res.status === 400 && /temperature/i.test(text)) {
      res = await send(false);
      if (res.ok) return res;
      text = await res.text().catch(() => res.statusText);
    }
    throw new Error(`${baseUrl} API error ${res.status}: ${text}`);
  }
  return res;
}

// ─── Gemini ───────────────────────────────────────────────────────────────────

// Maps the OpenAI messages array to Gemini's `contents` format. The system message becomes a
// `systemInstruction`; all other messages map 1:1 with role "user"/"model" (Gemini doesn't
// accept "assistant").
function toGeminiPayload(messages, { model, stream = false }) {
  const systemMsg = messages.find((m) => m.role === "system");
  const conversationMsgs = messages.filter((m) => m.role !== "system");

  return {
    endpoint: stream
      ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent`
      : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    body: {
      ...(systemMsg ? { system_instruction: { parts: [{ text: systemMsg.content }] } } : {}),
      contents: conversationMsgs.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      generationConfig: {
        temperature: stream ? STREAM_TEMPERATURE : JSON_TEMPERATURE,
      },
    },
  };
}

async function geminiRequest(messages, { apiKey, model, stream = false }) {
  const { endpoint, body } = toGeminiPayload(messages, { model, stream });
  const res = await fetch(`${endpoint}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Gemini API error ${res.status}: ${text}`);
  }
  return res;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveModel(provider, model) {
  if (model) return model;
  return OPENAI_COMPATIBLE_PROVIDERS[provider]?.defaultModel || "gpt-6-luna";
}

function providerBaseUrl(provider) {
  return OPENAI_COMPATIBLE_PROVIDERS[provider]?.baseUrl;
}

// ─── Public API ───────────────────────────────────────────────────────────────

// Checks an API key (and, when the provider lists them, the chosen model) with a cheap
// authenticated GET, without spending tokens. Returns { ok, message }. `ok` is false only when
// the key is rejected or the provider can't be reached; an unlisted model is reported as a
// warning in `message` with ok still true, since model lists can lag behind new releases.
export async function testApiKey({ provider, apiKey, model }) {
  if (!apiKey) return { ok: false, message: "Enter an API key first." };
  const resolvedModel = resolveModel(provider, model);
  let url;
  let headers = {};
  if (provider === "gemini") {
    url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=1000`;
  } else if (providerBaseUrl(provider)) {
    url = `${providerBaseUrl(provider)}/models`;
    headers = { Authorization: `Bearer ${apiKey}` };
  } else {
    return { ok: false, message: `Unknown provider "${provider}".` };
  }

  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    return { ok: false, message: "Couldn't reach the provider. Check your connection." };
  }
  if (res.status === 401 || res.status === 403 || (provider === "gemini" && res.status === 400)) {
    return { ok: false, message: "The provider rejected this key." };
  }
  if (!res.ok) return { ok: false, message: `The provider returned an error (${res.status}).` };

  try {
    const json = await res.json();
    const ids = provider === "gemini"
      ? (json.models || []).map((m) => String(m.name).replace(/^models\//, ""))
      : (json.data || []).map((m) => m.id);
    if (ids.length && !ids.includes(resolvedModel)) {
      return { ok: true, message: `Key works, but "${resolvedModel}" isn't in this account's model list.` };
    }
  } catch {
    // Unparseable list: the key was accepted, which is what was asked.
  }
  return { ok: true, message: `Key works. Using ${resolvedModel}.` };
}

// Non-streaming chat call for the agent's internal decisions (query planning, sufficiency
// checks). Returns the raw text content of the model's reply.
export async function chatJSONApi(messages, { provider, apiKey, model }) {
  const resolvedModel = resolveModel(provider, model);

  if (provider === "gemini") {
    const res = await geminiRequest(messages, { apiKey, model: resolvedModel });
    const json = await res.json();
    return json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  }

  const baseUrl = providerBaseUrl(provider);
  const res = await openAIRequest(messages, {
    apiKey,
    model: resolvedModel,
    baseUrl,
    responseFormat: { type: "json_object" },
  });
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? "";
}

// Streaming chat call for the final user-facing answer. Calls `onToken(delta, fullSoFar)` for
// each new token and returns the complete response string. Behaviour is identical to the
// WebLLM chatStream() in llm.js so callers need no special-casing.
export async function chatStreamApi(messages, { provider, apiKey, model }, onToken) {
  const resolvedModel = resolveModel(provider, model);
  let full = "";

  if (provider === "gemini") {
    // Gemini's streaming endpoint returns newline-delimited JSON objects, each wrapped in a
    // data: [...] SSE envelope. We read the body as text and parse each chunk.
    const res = await geminiRequest(messages, { apiKey, model: resolvedModel, stream: true });
    const text = await res.text();
    // Each chunk is a JSON object in the array returned by streamGenerateContent.
    // The response is a valid JSON array when complete; we extract text parts from each element.
    let chunks;
    try {
      chunks = JSON.parse(text);
    } catch {
      chunks = [];
    }
    for (const chunk of chunks) {
      const delta = chunk.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      if (delta) {
        full += delta;
        onToken(delta, full);
      }
    }
    return full;
  }

  // OpenAI / Groq: standard SSE streaming
  const baseUrl = providerBaseUrl(provider);
  const res = await openAIRequest(messages, { apiKey, model: resolvedModel, baseUrl, stream: true });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep the incomplete last line for next iteration
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") break;
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          full += delta;
          onToken(delta, full);
        }
      } catch {
        // malformed SSE line -- skip and continue
      }
    }
  }
  return full;
}
