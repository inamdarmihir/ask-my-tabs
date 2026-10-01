import React, { useId, useState } from "react";
import { Select as SelectPrimitive, RadioGroup, ToggleGroup, Tabs as TabsPrimitive, Switch as SwitchPrimitive, Collapsible, Checkbox as CheckboxPrimitive } from "radix-ui";
import { motion } from "motion/react";
import { Check, ChevronDown, Eye, EyeOff } from "lucide-react";
import { cn } from "./cn.js";
import { Input, Label } from "./primitives.jsx";

// ─── Field ──────────────────────────────────────────────────────────────────
export function Field({ label, hint, htmlFor, children, className }) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && <Label htmlFor={htmlFor}>{label}</Label>}
      {children}
      {hint && <p className="text-pretty text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function PasswordInput({ className, ...props }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input type={shown ? "text" : "password"} autoComplete="off" spellCheck={false} className={cn("pr-9", className)} {...props} />
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        aria-label={shown ? "Hide value" : "Show value"}
        className="absolute inset-y-0 right-0 grid w-9 place-items-center rounded-r-lg text-muted-foreground hover:text-foreground"
      >
        {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

// ─── Select ─────────────────────────────────────────────────────────────────
export function Select({ value, onValueChange, options, placeholder, className, "aria-label": ariaLabel, id }) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange}>
      <SelectPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          "flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-input bg-card px-3 text-left text-[13px] shadow-xs transition-[border-color,box-shadow] focus-visible:border-primary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring data-[placeholder]:text-muted-foreground",
          className,
        )}
      >
        <span className="truncate">
          <SelectPrimitive.Value placeholder={placeholder} />
        </span>
        <SelectPrimitive.Icon>
          <ChevronDown className="size-4 text-muted-foreground" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={4} collisionPadding={8} className="z-50 max-h-[min(300px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-border bg-card p-1 shadow-float data-[state=open]:animate-pop-in">
          <SelectPrimitive.Viewport>
            {options.map((o) => (
              <SelectPrimitive.Item key={o.value} value={o.value} className="relative flex cursor-default select-none flex-col rounded-lg py-1.5 pl-7 pr-2 text-[13px] outline-none data-[highlighted]:bg-muted">
                <span className="absolute left-2 top-2 grid size-4 place-items-center">
                  <SelectPrimitive.ItemIndicator>
                    <Check className="size-3.5 text-primary" />
                  </SelectPrimitive.ItemIndicator>
                </span>
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                {o.description && <span className="text-xs text-muted-foreground">{o.description}</span>}
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

// ─── Radio cards ────────────────────────────────────────────────────────────
export function RadioCards({ value, onValueChange, options, label }) {
  return (
    <RadioGroup.Root value={value} onValueChange={onValueChange} aria-label={label} className="grid gap-2">
      {options.map((o) => (
        <RadioGroup.Item
          key={o.value}
          value={o.value}
          className="group flex items-start gap-3 rounded-xl border border-border bg-card p-3 text-left transition-[border-color,background-color,box-shadow] hover:border-input focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring data-[state=checked]:border-primary data-[state=checked]:bg-accent/50 data-[state=checked]:shadow-soft"
        >
          {o.icon && (
            <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground transition-colors group-data-[state=checked]:bg-primary group-data-[state=checked]:text-primary-foreground">
              <o.icon className="size-4" />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
              {o.title}
              {o.badge}
            </span>
            <span className="mt-0.5 block text-pretty text-xs text-muted-foreground">{o.description}</span>
          </span>
          <span className="mt-1 grid size-4 shrink-0 place-items-center rounded-full border border-input transition-colors group-data-[state=checked]:border-primary group-data-[state=checked]:bg-primary">
            <RadioGroup.Indicator>
              <Check className="size-3 text-primary-foreground" strokeWidth={3} />
            </RadioGroup.Indicator>
          </span>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}

// ─── Segmented control (animated pill) ──────────────────────────────────────
export function Segmented({ value, onValueChange, options, label, className }) {
  const id = useId();
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      // Radix reports "" when the active item is clicked again; a segmented control always has a value.
      onValueChange={(v) => v && onValueChange(v)}
      aria-label={label}
      className={cn("inline-flex rounded-lg bg-muted p-0.5", className)}
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          title={o.title}
          className="relative rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring data-[state=on]:text-foreground"
        >
          {value === o.value && (
            <motion.span layoutId={`seg-${id}`} className="absolute inset-0 rounded-md bg-card shadow-sm ring-1 ring-black/5 dark:ring-white/10" transition={{ type: "spring", stiffness: 500, damping: 38 }} />
          )}
          <span className="relative z-10 inline-flex items-center gap-1.5">{o.label}</span>
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

// ─── Navigation tabs (animated underline) ───────────────────────────────────
export function NavTabs({ value, onValueChange, items, className }) {
  const id = useId();
  return (
    <TabsPrimitive.Root value={value} onValueChange={onValueChange}>
      <TabsPrimitive.List className={cn("flex gap-1 border-b border-border px-3", className)}>
        {items.map((it) => (
          <TabsPrimitive.Trigger
            key={it.value}
            value={it.value}
            className="relative inline-flex items-center gap-1.5 px-2.5 py-2 text-[13px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground data-[state=active]:text-foreground [&_svg]:size-4"
          >
            {it.label}
            {value === it.value && (
              <motion.span layoutId={`tab-${id}`} className="absolute inset-x-1.5 -bottom-px h-0.5 rounded-full bg-primary" transition={{ type: "spring", stiffness: 500, damping: 40 }} />
            )}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}

// ─── Switch ─────────────────────────────────────────────────────────────────
export function Switch({ className, ...props }) {
  return (
    <SwitchPrimitive.Root
      className={cn("inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent bg-input transition-colors data-[state=checked]:bg-primary", className)}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-4 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-4" />
    </SwitchPrimitive.Root>
  );
}

export { Collapsible };

export function Checkbox({ className, ...props }) {
  return (
    <CheckboxPrimitive.Root
      className={cn("grid size-4 shrink-0 place-items-center rounded-[5px] border border-input bg-card transition-colors data-[state=checked]:border-primary data-[state=checked]:bg-primary", className)}
      {...props}
    >
      <CheckboxPrimitive.Indicator>
        <Check className="size-3 text-primary-foreground" strokeWidth={3.5} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
