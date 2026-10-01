import React from "react";
import { AppWindow, Cpu, Database, History, Monitor, Moon, MoreHorizontal, RefreshCw, Settings, SquarePen, Sun } from "lucide-react";
import { cn } from "../ui/cn.js";
import { Button } from "../ui/button.jsx";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, Popover, PopoverContent, PopoverTrigger, Tip } from "../ui/overlay.jsx";
import { useThemePref } from "../ui/hooks.js";

const openSettings = () => chrome.runtime.openOptionsPage();

// Overall state of the two things the extension depends on.
export function overallStatus({ qdrant, model }) {
  if (qdrant.status === "checking") return "checking";
  if (qdrant.status === "down") return "offline";
  if (model.onDevice && !model.ready) return "setup";
  return "ready";
}

const PILL = {
  checking: { label: "Checking", dot: "bg-muted-foreground animate-pulse" },
  offline: { label: "Offline", dot: "bg-destructive" },
  setup: { label: "Setup needed", dot: "bg-warning" },
  ready: { label: "Ready", dot: "bg-success" },
};

function StatusRow({ icon: Icon, title, detail, tone, action }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-[13px] font-medium">
          {title}
          <span className={cn("size-1.5 rounded-full", tone === "ok" ? "bg-success" : tone === "bad" ? "bg-destructive" : tone === "warn" ? "bg-warning" : "bg-muted-foreground animate-pulse")} />
        </p>
        <p className="text-pretty text-xs text-muted-foreground">{detail}</p>
      </div>
      {action}
    </div>
  );
}

function StatusPill({ status, qdrant, checkQdrant, model }) {
  const pill = PILL[status];
  const qTone = qdrant.status === "up" ? "ok" : qdrant.status === "down" ? "bad" : "busy";
  const qDetail =
    qdrant.status === "up" ? `Connected to Qdrant (${qdrant.location === "local" ? "on this computer" : "cloud"})`
    : qdrant.status === "down" ? (qdrant.location === "local" ? "Not reachable. Run docker compose up -d, then re-check." : "Not reachable. Check the URL and API key in Settings.")
    : "Checking the connection...";
  const mTone = !model.onDevice || model.ready ? "ok" : model.error ? "bad" : "warn";
  const mDetail = model.label ? `${model.label} (your API key)` : model.ready ? "On-device model is ready" : model.loading ? "On-device model is loading..." : "On-device model isn't downloaded yet";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="flex h-7 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label={`Status: ${pill.label}. Show details`}>
          <span className={cn("size-2 rounded-full", pill.dot)} />
          {pill.label}
        </button>
      </PopoverTrigger>
      <PopoverContent className="flex flex-col gap-3">
        <StatusRow
          icon={Database}
          title="Vector database"
          tone={qTone}
          detail={qDetail}
          action={
            <Tip label="Check again">
              <Button variant="ghost" size="icon-sm" onClick={checkQdrant} aria-label="Check the database again">
                <RefreshCw className={cn(qdrant.status === "checking" && "animate-spin")} />
              </Button>
            </Tip>
          }
        />
        <StatusRow icon={Cpu} title="Answers" tone={mTone} detail={mDetail} />
        <Button variant="outline" size="sm" onClick={openSettings}>
          <Settings /> Change in Settings
        </Button>
      </PopoverContent>
    </Popover>
  );
}

const THEMES = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

export function Header({ full, status, qdrant, checkQdrant, model, onNewChat, onOpenHistory }) {
  const [theme, setTheme] = useThemePref();
  return (
    <header className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
      <div className="flex min-w-0 items-center gap-2">
        <img src="icons/icon48.png" alt="" width="24" height="24" className="rounded-md" />
        <h1 className="truncate text-[15px] font-semibold tracking-tight">Ask My Tabs</h1>
      </div>
      <div className="flex items-center gap-1">
        <StatusPill status={status} qdrant={qdrant} checkQdrant={checkQdrant} model={model} />
        <Tip label="New chat">
          <Button variant="ghost" size="icon" onClick={onNewChat} aria-label="New chat">
            <SquarePen />
          </Button>
        </Tip>
        <Tip label="History">
          <Button variant="ghost" size="icon" onClick={onOpenHistory} aria-label="History">
            <History />
          </Button>
        </Tip>
        <Menu>
          <Tip label="More">
            <MenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="More options">
                <MoreHorizontal />
              </Button>
            </MenuTrigger>
          </Tip>
          <MenuContent>
            {!full && (
              <MenuItem onSelect={() => chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?full=1") })}>
                <AppWindow /> Open in a tab
              </MenuItem>
            )}
            <MenuItem onSelect={openSettings}>
              <Settings /> Settings
            </MenuItem>
            <MenuSeparator />
            <MenuLabel>Appearance</MenuLabel>
            <MenuRadioGroup value={theme} onValueChange={setTheme}>
              {THEMES.map((t) => (
                <MenuRadioItem key={t.value} value={t.value}>
                  <t.icon /> {t.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
      </div>
    </header>
  );
}
