import React from "react";
import { Progress as ProgressPrimitive } from "radix-ui";
import { motion } from "motion/react";
import { Check } from "lucide-react";
import { cn } from "./cn.js";

// Determinate when `value` is a number (0-100); indeterminate (sliding bar) when null.
export function Progress({ value, className, barClassName, ...props }) {
  const determinate = typeof value === "number";
  return (
    <ProgressPrimitive.Root
      value={determinate ? value : null}
      className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
      {...props}
    >
      {determinate ? (
        <ProgressPrimitive.Indicator asChild>
          <motion.div
            className={cn("h-full rounded-full bg-primary", barClassName)}
            initial={false}
            animate={{ width: `${Math.max(2, Math.min(100, value))}%` }}
            transition={{ type: "spring", stiffness: 140, damping: 26 }}
          />
        </ProgressPrimitive.Indicator>
      ) : (
        <ProgressPrimitive.Indicator className={cn("absolute inset-y-0 left-0 w-2/5 animate-indeterminate rounded-full bg-primary", barClassName)} />
      )}
    </ProgressPrimitive.Root>
  );
}

// Horizontal step tracker: steps before `current` are done, `current` is active, the rest pending.
export function Stepper({ steps, current, className }) {
  return (
    <ol className={cn("flex items-center gap-1.5", className)} aria-label="Progress">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex min-w-0 flex-1 items-center gap-1.5" aria-current={active ? "step" : undefined}>
            <span
              className={cn(
                "grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold transition-colors",
                done && "bg-success text-white",
                active && "bg-primary text-primary-foreground",
                !done && !active && "bg-muted text-muted-foreground",
              )}
            >
              {done ? <Check className="size-3" strokeWidth={3} /> : i + 1}
            </span>
            <span className={cn("truncate text-xs", active ? "font-medium text-foreground" : "text-muted-foreground")}>{label}</span>
            {i < steps.length - 1 && <span className={cn("h-px min-w-2 flex-1 transition-colors", done ? "bg-success" : "bg-border")} />}
          </li>
        );
      })}
    </ol>
  );
}
