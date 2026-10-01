import React, { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ArrowRight, Check, LoaderCircle, Pin, Plus, MessageSquare } from "lucide-react";
import { saveConfig } from "../lib/config.js";
import { makeClient } from "../lib/qdrant.js";
import { LOCAL_QDRANT_URL, modelPatch, storagePatch } from "../ui/config-form.js";
import { Button } from "../ui/button.jsx";
import { ModelFields, StorageFields, testQdrant } from "../ui/forms.jsx";
import { send, useModel } from "../ui/hooks.js";
import { ModelDownload } from "../ui/model-download.jsx";
import { Notice } from "../ui/primitives.jsx";
import { Progress, Stepper } from "../ui/progress.jsx";
import { Toaster } from "../ui/toaster.jsx";

const STEPS = ["Storage", "Answers", "Ready"];

async function persist(patch) {
  await saveConfig(patch);
  await send({ type: "SET_CONFIG", patch });
}

function StepShell({ title, description, children, footer }) {
  return (
    <motion.section
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -24 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className="rounded-2xl border border-border bg-card p-5 shadow-soft"
    >
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="mb-4 mt-0.5 text-pretty text-xs text-muted-foreground">{description}</p>
      {children}
      <div className="mt-5 flex items-center justify-between gap-2">{footer}</div>
    </motion.section>
  );
}

function StorageStep({ onNext }) {
  const [value, setValue] = useState({ mode: "cloud", url: "", apiKey: "" });
  const [detected, setDetected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // If Qdrant is already running locally, preselect it so most local users just click Continue.
  useEffect(() => {
    makeClient({ url: LOCAL_QDRANT_URL })
      .health()
      .then((res) => {
        if (res.reachable && res.ready) {
          setDetected(true);
          setValue((v) => ({ ...v, mode: "local" }));
        }
      })
      .catch(() => {});
  }, []);

  const next = async () => {
    setBusy(true);
    setError(null);
    const r = await testQdrant(value);
    if (r.tone === "success") {
      await persist(storagePatch(value));
      onNext();
    } else {
      setError(r.text);
    }
    setBusy(false);
  };

  return (
    <StepShell
      title="Where should your pages live?"
      description="Pages you add are turned into searchable snippets and stored in a Qdrant database that you own."
      footer={
        <>
          <span className="min-w-0 flex-1">{error && <Notice tone="danger">{error}</Notice>}</span>
          <Button size="lg" onClick={next} disabled={busy} className="shrink-0">
            {busy ? <LoaderCircle className="animate-spin" /> : null}
            {busy ? "Testing..." : "Test and continue"}
            {!busy && <ArrowRight />}
          </Button>
        </>
      }
    >
      <StorageFields value={value} onChange={(v) => { setError(null); setValue(v); }} detectedLocal={detected} showTest={false} />
    </StepShell>
  );
}

function ModelStep({ onBack, onNext }) {
  const [value, setValue] = useState({ type: "local", provider: "openai", apiKey: "", model: "", baseUrl: "" });
  const [busy, setBusy] = useState(false);
  const needsKey = value.type === "api" && !value.apiKey.trim();

  const finish = async () => {
    setBusy(true);
    await persist(modelPatch(value));
    onNext(value.type === "local");
  };

  return (
    <StepShell
      title="Who writes your answers?"
      description="You can change this any time in Settings."
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onBack} disabled={busy}><ArrowLeft /> Back</Button>
          <Button size="lg" onClick={finish} disabled={busy || needsKey} title={needsKey ? "Paste your API key to continue" : undefined}>
            {busy ? <LoaderCircle className="animate-spin" /> : <Check />} Finish
          </Button>
        </>
      }
    >
      <ModelFields value={value} onChange={setValue} />
    </StepShell>
  );
}

function DoneStep({ onDevice }) {
  const [model, download] = useModel();
  useEffect(() => {
    // They just chose the on-device model: start the one-time download now, with a live bar.
    if (onDevice) download();
  }, [onDevice, download]);

  return (
    <StepShell title="You're all set" description="Here's how to ask your first question." footer={<Button size="lg" className="ml-auto" onClick={() => window.close()}>Close this tab</Button>}>
      <div className="flex flex-col gap-4">
        <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 18 }} className="mx-auto grid size-14 place-items-center rounded-full bg-success text-white shadow-soft">
          <Check className="size-7" strokeWidth={3} />
        </motion.div>
        {onDevice && (
          <div className="rounded-xl border border-border bg-muted/40 p-3">
            {model.ready ? (
              <Notice tone="success">The on-device model is downloaded and ready.</Notice>
            ) : (
              <ModelDownload model={model} onDownload={download} />
            )}
          </div>
        )}
        <ol className="flex flex-col gap-2.5 text-[13px]">
          {[
            { icon: Pin, text: "Pin Ask My Tabs from the puzzle-piece menu so it's one click away." },
            { icon: Plus, text: "Open a page you want to ask about, then click the icon and choose Add." },
            { icon: MessageSquare, text: "Type a question. Answers cite the exact pages they came from." },
          ].map(({ icon: Icon, text }, i) => (
            <li key={i} className="flex items-center gap-3">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground"><Icon className="size-4" /></span>
              <span className="text-pretty">{text}</span>
            </li>
          ))}
        </ol>
      </div>
    </StepShell>
  );
}

export function OnboardingApp() {
  const [step, setStep] = useState(0);
  const [onDevice, setOnDevice] = useState(false);

  return (
    <div className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 px-4 py-10">
      <header className="flex flex-col items-center gap-2 text-center">
        <img src="icons/icon128.png" alt="" width="56" height="56" className="rounded-2xl shadow-soft" />
        <h1 className="text-balance text-2xl font-semibold tracking-tight">Welcome to Ask My Tabs</h1>
        <p className="text-pretty text-sm text-muted-foreground">Two quick steps. You only do this once.</p>
      </header>

      <div className="flex flex-col gap-3">
        <Stepper steps={STEPS} current={step === STEPS.length - 1 ? STEPS.length : step} />
        <Progress value={step === STEPS.length - 1 ? 100 : ((step + 0.5) / STEPS.length) * 100} aria-label={`Step ${step + 1} of ${STEPS.length}`} />
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {step === 0 && <StorageStep key="s0" onNext={() => setStep(1)} />}
        {step === 1 && <ModelStep key="s1" onBack={() => setStep(0)} onNext={(local) => { setOnDevice(local); setStep(2); }} />}
        {step === 2 && <DoneStep key="s2" onDevice={onDevice} />}
      </AnimatePresence>
      <Toaster />
    </div>
  );
}
