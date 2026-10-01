import React, { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Cloud, Cpu, ExternalLink, KeyRound, LoaderCircle, Plug, Server, Zap } from "lucide-react";
import { ALL_API_PROVIDERS } from "../lib/config.js";
import { makeClient } from "../lib/qdrant.js";
import { testApiKey, listModels } from "../lib/llm-api.js";
import { hasWebGPU } from "../lib/gpu.js";
import { LOCAL_QDRANT_URL } from "./config-form.js";
import { Button } from "./button.jsx";
import { Field, PasswordInput, RadioCards, Select } from "./form.jsx";
import { Badge, Input, Notice } from "./primitives.jsx";

function Reveal({ show, children }) {
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
          <div className="flex flex-col gap-3 pt-3">{children}</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// Result of a connection or key test: null (untested), "testing", or {tone, text}.
function TestResult({ result }) {
  if (!result) return null;
  if (result === "testing") {
    return <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" /> Testing...</span>;
  }
  return <Notice tone={result.tone} className="flex-1">{result.text}</Notice>;
}

// ─── Vector storage ─────────────────────────────────────────────────────────
export async function testQdrant(value) {
  const url = value.mode === "local" ? LOCAL_QDRANT_URL : value.url.trim();
  if (!url) return { tone: "danger", text: "Enter your cluster URL first." };
  try {
    const res = await makeClient({ url, apiKey: value.mode === "local" ? "" : value.apiKey.trim() }).health();
    if (res.reachable && res.ready) return { tone: "success", text: "Connected." };
    if (res.reachable) return { tone: "warning", text: "Reached the server, but it isn't ready yet. Try again in a moment." };
    return { tone: "danger", text: value.mode === "local" ? "Can't reach Qdrant on this computer. Is docker compose up -d running?" : "Can't reach that URL. Check the address and your API key." };
  } catch {
    return { tone: "danger", text: "Something went wrong while connecting." };
  }
}

export function StorageFields({ value, onChange, detectedLocal, showTest = true }) {
  const [result, setResult] = useState(null);
  const set = (patch) => {
    setResult(null);
    onChange({ ...value, ...patch });
  };
  const run = async () => {
    setResult("testing");
    setResult(await testQdrant(value));
  };

  return (
    <div className="flex flex-col">
      <RadioCards
        label="Where your pages are stored"
        value={value.mode}
        onValueChange={(mode) => set({ mode })}
        options={[
          {
            value: "cloud",
            icon: Cloud,
            title: "Qdrant Cloud",
            badge: <Badge tone="accent">No Docker needed</Badge>,
            description: (<>Free tier at <a className="text-primary underline-offset-2 hover:underline" href="https://cloud.qdrant.io" target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>cloud.qdrant.io</a>. Works from any computer.</>),
          },
          {
            value: "local",
            icon: Server,
            title: "Local Docker",
            badge: detectedLocal ? <Badge tone="success">Found on this computer</Badge> : null,
            description: (<>Private and offline. Needs <code className="rounded bg-muted px-1 font-mono text-[11px]">docker compose up -d</code>.</>),
          },
        ]}
      />
      <Reveal show={value.mode === "cloud"}>
        <Field label="Cluster URL" htmlFor="qdrant-url">
          <Input id="qdrant-url" type="url" value={value.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://abc.qdrant.io:6333" />
        </Field>
        <Field label="API key" htmlFor="qdrant-key">
          <PasswordInput id="qdrant-key" value={value.apiKey} onChange={(e) => set({ apiKey: e.target.value })} placeholder="Paste your Qdrant API key" />
        </Field>
      </Reveal>
      {showTest && (
        <div className="mt-3 flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={run} disabled={result === "testing"}><Plug /> Test connection</Button>
          <TestResult result={result} />
        </div>
      )}
    </div>
  );
}

// ─── Answer model ───────────────────────────────────────────────────────────
function WebGpuNotice() {
  const [gpu, setGpu] = useState(null);
  useEffect(() => {
    hasWebGPU().then(setGpu);
  }, []);
  if (gpu === null) return <Notice tone="info">Checking for WebGPU...</Notice>;
  return gpu ? (
    <Notice tone="success">WebGPU is available on this computer, so the on-device model will run here.</Notice>
  ) : (
    <Notice tone="warning">
      WebGPU isn't available in this browser profile, so the on-device model can't run. Check <code className="font-mono">chrome://gpu</code>, update graphics drivers, or choose an API key instead.
    </Notice>
  );
}

export function ModelFields({ value, onChange }) {
  const [result, setResult] = useState(null);
  const [models, setModels] = useState([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const provider = ALL_API_PROVIDERS[value.provider];
  const set = (patch) => {
    setResult(null);
    onChange({ ...value, ...patch });
  };

  const test = async () => {
    setResult("testing");
    const r = await testApiKey({ provider: value.provider, apiKey: value.apiKey.trim(), model: value.model.trim() });
    setResult({ tone: r.ok ? "success" : "danger", text: r.message });
  };
  const fetchModels = async () => {
    setLoadingModels(true);
    const r = await listModels({ provider: value.provider, apiKey: value.apiKey.trim() });
    setLoadingModels(false);
    setModels(r.models || []);
    setResult({ tone: r.ok ? "success" : "danger", text: r.ok ? `${r.models.length} models found. Click the Model box to choose one.` : r.message });
  };

  return (
    <div className="flex flex-col">
      <RadioCards
        label="Who writes your answers"
        value={value.type}
        onValueChange={(type) => set({ type })}
        options={[
          {
            value: "api",
            icon: Zap,
            title: "API key",
            badge: <Badge tone="accent">Fast</Badge>,
            description: "Quick and light. Only the question and matching snippets are sent to the provider you pick.",
          },
          {
            value: "local",
            icon: Cpu,
            title: "On this device",
            badge: <Badge>Private</Badge>,
            description: "Nothing leaves your computer. Needs a WebGPU-capable GPU and a one-time download of about 0.5 GB.",
          },
        ]}
      />
      <Reveal show={value.type === "api"}>
        <Field label="Provider" htmlFor="llm-provider">
          <Select
            id="llm-provider"
            value={value.provider}
            onValueChange={(provider) => { setModels([]); set({ provider }); }}
            options={Object.entries(ALL_API_PROVIDERS).map(([id, p]) => ({ value: id, label: p.label }))}
          />
        </Field>
        <Field
          label="API key"
          htmlFor="llm-key"
          hint={provider && (<a className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline" href={provider.keyUrl} target="_blank" rel="noreferrer">Get a key from {provider.label} <ExternalLink className="size-3" /></a>)}
        >
          <PasswordInput id="llm-key" value={value.apiKey} onChange={(e) => set({ apiKey: e.target.value })} placeholder={provider?.keyHint || "API key"} />
        </Field>
        <Field label="Model (optional)" htmlFor="llm-model" hint={provider && `Leave blank to use ${provider.defaultModel}.`}>
          <div className="flex gap-2">
            <Input id="llm-model" list="llm-model-list" value={value.model} onChange={(e) => set({ model: e.target.value })} placeholder={provider?.defaultModel} />
            <datalist id="llm-model-list">
              {models.map((m) => <option key={m} value={m} />)}
            </datalist>
            <Button variant="outline" size="md" className="h-9" onClick={fetchModels} disabled={loadingModels || !value.apiKey.trim()} title={value.apiKey.trim() ? "List the models this key can use" : "Enter your API key first"}>
              {loadingModels ? <LoaderCircle className="animate-spin" /> : null} List
            </Button>
          </div>
        </Field>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={test} disabled={result === "testing" || !value.apiKey.trim()}><KeyRound /> Test key</Button>
          <TestResult result={result} />
        </div>
      </Reveal>
      <Reveal show={value.type === "local"}>
        <WebGpuNotice />
      </Reveal>
    </div>
  );
}
