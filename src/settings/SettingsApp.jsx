import React, { useCallback, useEffect, useState } from "react";
import { Database, Monitor, Moon, Palette, RotateCcw, Save, Sliders, Sparkles, Sun } from "lucide-react";
import { getConfig, saveConfig, DEFAULT_CONFIG } from "../lib/config.js";
import { modelFromConfig, modelPatch, patchesDiffer, storageFromConfig, storagePatch } from "../ui/config-form.js";
import { Button } from "../ui/button.jsx";
import { Field, Segmented, Select } from "../ui/form.jsx";
import { ModelFields, StorageFields } from "../ui/forms.jsx";
import { useThemePref, send } from "../ui/hooks.js";
import { ConfirmDialog } from "../ui/overlay.jsx";
import { Input, Skeleton } from "../ui/primitives.jsx";
import { Toaster, toast } from "../ui/toaster.jsx";
import { cn } from "../ui/cn.js";

function Section({ icon: Icon, title, description, children }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-soft">
      <div className="mb-4 flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground">
          <Icon className="size-[18px]" />
        </span>
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          <p className="text-pretty text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

const THEME_OPTIONS = [
  { value: "system", label: (<><Monitor className="size-3.5" />System</>) },
  { value: "light", label: (<><Sun className="size-3.5" />Light</>) },
  { value: "dark", label: (<><Moon className="size-3.5" />Dark</>) },
];

export function SettingsApp() {
  const [baseline, setBaseline] = useState(null);
  const [storage, setStorage] = useState(null);
  const [model, setModel] = useState(null);
  const [agentMode, setAgentMode] = useState("deep");
  const [saving, setSaving] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [theme, setTheme] = useThemePref();

  const apply = useCallback((cfg) => {
    const s = storageFromConfig(cfg);
    const m = modelFromConfig(cfg);
    setStorage(s);
    setModel(m);
    setAgentMode(cfg.agentMode || "deep");
    setBaseline({ ...storagePatch(s), ...modelPatch(m), agentMode: cfg.agentMode || "deep" });
  }, []);

  useEffect(() => {
    getConfig().then(apply);
  }, [apply]);

  const loaded = !!storage && !!model;
  const patch = loaded ? { ...storagePatch(storage), ...modelPatch(model), agentMode } : null;
  const dirty = loaded && patchesDiffer(patch, baseline);

  const persist = useCallback(async (next) => {
    await saveConfig(next);
    await send({ type: "SET_CONFIG", patch: next });
  }, []);

  const save = useCallback(async () => {
    if (!patch || saving) return;
    if (storage.mode === "cloud" && !storage.url.trim()) {
      toast.error("Enter your Qdrant cluster URL", { description: "Or choose Local Docker if Qdrant runs on this computer." });
      return;
    }
    setSaving(true);
    try {
      await persist(patch);
      setBaseline(patch);
      toast.success("Settings saved", { description: "They apply right away." });
    } catch (err) {
      toast.error("Couldn't save settings", { description: String(err?.message || err) });
    } finally {
      setSaving(false);
    }
  }, [patch, storage, saving, persist]);

  // Cmd/Ctrl+S saves.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty) save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, save]);

  const reset = async () => {
    await persist(DEFAULT_CONFIG);
    apply({ ...DEFAULT_CONFIG });
    toast.success("Settings reset to defaults");
  };

  return (
    <div className="min-h-screen pb-24">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 pt-10">
        <header className="mb-2 flex items-center gap-3">
          <img src="icons/icon48.png" alt="" width="36" height="36" className="rounded-lg" />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
            <p className="text-xs text-muted-foreground">Choose where your pages live and who writes your answers.</p>
          </div>
        </header>

        {!loaded ? (
          <div className="flex flex-col gap-4" aria-busy="true">
            <Skeleton className="h-64 w-full rounded-2xl" />
            <Skeleton className="h-64 w-full rounded-2xl" />
          </div>
        ) : (
          <>
            <Section icon={Database} title="Vector storage" description="Where your indexed pages are stored and searched.">
              <StorageFields value={storage} onChange={setStorage} />
            </Section>

            <Section icon={Sparkles} title="Answers" description="Which model reads your pages and writes the answer.">
              <ModelFields value={model} onChange={setModel} />
            </Section>

            <Section icon={Sliders} title="Advanced" description="You can leave these as they are.">
              <div className="flex flex-col gap-4">
                <Field label="Answer strategy" htmlFor="agent-mode" hint="The deep agent makes several model calls per question and works with OpenAI-compatible providers. It falls back to the fast pipeline if anything goes wrong.">
                  <Select
                    id="agent-mode"
                    value={agentMode}
                    onValueChange={setAgentMode}
                    options={[
                      { value: "deep", label: "Deep agent", description: "Plans, searches and reads your pages as needed. Recommended." },
                      { value: "pipeline", label: "Fast pipeline", description: "One search or read, then answer." },
                    ]}
                  />
                </Field>
                {model.type === "api" && (
                  <Field label="Custom endpoint (optional)" htmlFor="llm-baseurl" hint="Any OpenAI-compatible base URL, such as Ollama, LM Studio, Azure or a proxy. Leave blank to use the provider's own.">
                    <Input id="llm-baseurl" type="url" value={model.baseUrl} onChange={(e) => setModel({ ...model, baseUrl: e.target.value })} placeholder="http://127.0.0.1:11434/v1" />
                  </Field>
                )}
              </div>
            </Section>

            <Section icon={Palette} title="Appearance" description="Follow your system or pick a theme.">
              <Segmented value={theme} onValueChange={setTheme} options={THEME_OPTIONS} label="Theme" />
            </Section>

            <footer className="flex items-center justify-between px-1 text-xs text-muted-foreground">
              <Button variant="link" size="sm" className="h-auto p-0 text-xs text-muted-foreground hover:text-destructive" onClick={() => setConfirmReset(true)}>
                <RotateCcw className="size-3" /> Reset to defaults
              </Button>
              <a className="underline-offset-2 hover:text-foreground hover:underline" href="privacy-policy.html">Privacy policy</a>
            </footer>
          </>
        )}
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-3">
          <span className={cn("flex items-center gap-2 text-xs", dirty ? "text-foreground" : "text-muted-foreground")} role="status">
            <span className={cn("size-2 rounded-full", dirty ? "bg-warning" : "bg-success")} />
            {dirty ? "You have unsaved changes" : "All changes saved"}
          </span>
          <Button size="lg" onClick={save} disabled={!dirty || saving} className="h-9">
            <Save /> {saving ? "Saving..." : "Save changes"}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Reset all settings?"
        description="Storage, answer model, API keys and the answer strategy go back to their defaults. Your indexed pages and chats are not touched."
        confirmLabel="Reset"
        onConfirm={reset}
      />
      <Toaster position="bottom-center" offset={76} />
    </div>
  );
}
