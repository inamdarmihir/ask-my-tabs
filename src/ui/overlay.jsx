import React from "react";
import { Tooltip as TooltipPrimitive, Dialog, AlertDialog as AlertPrimitive, Popover as PopoverPrimitive, HoverCard as HoverPrimitive, DropdownMenu as MenuPrimitive } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "./cn.js";
import { Button } from "./button.jsx";

// ─── Tooltip ────────────────────────────────────────────────────────────────
export function TooltipProvider({ children }) {
  return <TooltipPrimitive.Provider delayDuration={350} skipDelayDuration={200}>{children}</TooltipPrimitive.Provider>;
}

export function Tip({ label, children, side = "bottom" }) {
  if (!label) return children;
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-50 max-w-[260px] rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-float animate-fade-in"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

// ─── Sheet (side drawer) ────────────────────────────────────────────────────
export function Sheet({ open, onOpenChange, title, description, children, container }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal container={container}>
        <Dialog.Overlay className="absolute inset-0 z-40 bg-black/40 backdrop-blur-[1px] data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <Dialog.Content className="absolute inset-y-0 left-0 z-50 flex w-[86%] max-w-[340px] flex-col gap-3 border-r border-border bg-background p-3 shadow-float data-[state=closed]:animate-sheet-out data-[state=open]:animate-sheet-in">
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-sm font-semibold">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <X />
              </Button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">{description || title}</Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ─── Confirm dialog ─────────────────────────────────────────────────────────
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = "Delete", onConfirm, container }) {
  return (
    <AlertPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AlertPrimitive.Portal container={container}>
        <AlertPrimitive.Overlay className="fixed inset-0 z-50 bg-black/45 data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <AlertPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,340px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-card p-4 shadow-float data-[state=open]:animate-pop-in">
          <AlertPrimitive.Title className="text-sm font-semibold">{title}</AlertPrimitive.Title>
          <AlertPrimitive.Description className="mt-1.5 text-pretty text-xs text-muted-foreground">{description}</AlertPrimitive.Description>
          <div className="mt-4 flex justify-end gap-2">
            <AlertPrimitive.Cancel asChild>
              <Button variant="outline" size="sm">Cancel</Button>
            </AlertPrimitive.Cancel>
            <AlertPrimitive.Action asChild>
              <Button variant="destructive" size="sm" onClick={onConfirm}>{confirmLabel}</Button>
            </AlertPrimitive.Action>
          </div>
        </AlertPrimitive.Content>
      </AlertPrimitive.Portal>
    </AlertPrimitive.Root>
  );
}

// ─── Popover / HoverCard ────────────────────────────────────────────────────
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export function PopoverContent({ className, align = "end", sideOffset = 8, ...props }) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn("z-50 w-[300px] rounded-xl border border-border bg-card p-3 text-card-foreground shadow-float outline-none data-[state=open]:animate-pop-in", className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export const HoverCard = HoverPrimitive.Root;
export const HoverCardTrigger = HoverPrimitive.Trigger;

export function HoverCardContent({ className, sideOffset = 6, ...props }) {
  return (
    <HoverPrimitive.Portal>
      <HoverPrimitive.Content
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn("z-50 w-[280px] rounded-xl border border-border bg-card p-3 text-card-foreground shadow-float data-[state=open]:animate-pop-in", className)}
        {...props}
      />
    </HoverPrimitive.Portal>
  );
}

// ─── Dropdown menu ──────────────────────────────────────────────────────────
export const Menu = MenuPrimitive.Root;
export const MenuTrigger = MenuPrimitive.Trigger;
export const MenuRadioGroup = MenuPrimitive.RadioGroup;

export function MenuContent({ className, align = "end", sideOffset = 6, ...props }) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn("z-50 min-w-[190px] rounded-xl border border-border bg-card p-1 text-card-foreground shadow-float data-[state=open]:animate-pop-in", className)}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

const itemClass = "relative flex cursor-default select-none items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] outline-none data-[highlighted]:bg-muted data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:text-muted-foreground";

export function MenuItem({ className, ...props }) {
  return <MenuPrimitive.Item className={cn(itemClass, className)} {...props} />;
}

export function MenuRadioItem({ className, children, ...props }) {
  return (
    <MenuPrimitive.RadioItem className={cn(itemClass, "data-[state=checked]:font-medium data-[state=checked]:text-primary", className)} {...props}>
      {children}
      <MenuPrimitive.ItemIndicator className="ml-auto size-1.5 rounded-full bg-primary" />
    </MenuPrimitive.RadioItem>
  );
}

export const MenuLabel = ({ className, ...props }) => (
  <MenuPrimitive.Label className={cn("px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground", className)} {...props} />
);
export const MenuSeparator = ({ className, ...props }) => <MenuPrimitive.Separator className={cn("my-1 h-px bg-border", className)} {...props} />;
