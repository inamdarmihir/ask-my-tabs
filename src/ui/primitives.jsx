import React from "react";
import { cva } from "class-variance-authority";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { cn } from "./cn.js";

export function Input({ className, type = "text", ...props }) {
  return (
    <input
      type={type}
      className={cn(
        "h-9 w-full min-w-0 rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-xs transition-[border-color,box-shadow] placeholder:text-muted-foreground/70 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:opacity-50 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }) {
  return <label className={cn("text-xs font-medium text-foreground", className)} {...props} />;
}

const badgeVariants = cva("inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 [&_svg]:size-3", {
  variants: {
    tone: {
      neutral: "bg-muted text-muted-foreground",
      accent: "bg-accent text-accent-foreground",
      success: "bg-success-soft text-success",
      warning: "bg-warning-soft text-warning-foreground",
      danger: "bg-destructive-soft text-destructive",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export function Badge({ className, tone, ...props }) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export function Skeleton({ className, ...props }) {
  return (
    <div
      className={cn("animate-shimmer rounded-md bg-[linear-gradient(90deg,var(--muted)_25%,color-mix(in_oklab,var(--muted),var(--foreground)_8%)_50%,var(--muted)_75%)] bg-[length:200%_100%]", className)}
      {...props}
    />
  );
}

export function Kbd({ className, ...props }) {
  return <kbd className={cn("rounded border border-border bg-muted px-1 font-sans text-[10px] font-medium text-muted-foreground", className)} {...props} />;
}

// A deterministic coloured initial in place of a favicon: no extra permission, nothing fetched.
const HUES = [277, 200, 155, 30, 340, 95, 240, 10];
function hueFor(text) {
  let h = 0;
  for (const ch of text || "") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

export function SiteAvatar({ domain = "", className }) {
  const initial = (domain.replace(/^www\./, "")[0] || "?").toUpperCase();
  const hue = hueFor(domain);
  return (
    <span
      aria-hidden="true"
      className={cn("grid size-7 shrink-0 place-items-center rounded-lg text-xs font-semibold", className)}
      style={{ background: `oklch(0.94 0.04 ${hue})`, color: `oklch(0.42 0.14 ${hue})` }}
    >
      {initial}
    </span>
  );
}

export function EmptyState({ icon: Icon, title, children, className }) {
  return (
    <div className={cn("flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-8 text-center", className)}>
      {Icon && (
        <span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
          <Icon className="size-5" />
        </span>
      )}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {children && <div className="max-w-[300px] text-pretty text-xs text-muted-foreground">{children}</div>}
    </div>
  );
}

const noticeTone = {
  info: { box: "bg-accent text-accent-foreground", icon: Info },
  success: { box: "bg-success-soft text-success", icon: CircleCheck },
  warning: { box: "bg-warning-soft text-warning-foreground", icon: TriangleAlert },
  danger: { box: "bg-destructive-soft text-destructive", icon: CircleAlert },
};

// Inline status message: icon + text, with an optional action on the right.
export function Notice({ tone = "info", children, action, className, role }) {
  const { box, icon: Icon } = noticeTone[tone];
  return (
    <div role={role || (tone === "danger" ? "alert" : "status")} className={cn("flex items-start gap-2 rounded-xl px-3 py-2 text-xs", box, className)}>
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1 text-pretty">{children}</div>
      {action}
    </div>
  );
}
