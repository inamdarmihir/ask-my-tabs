import React from "react";
import { Toaster as Sonner, toast } from "sonner";
import { useThemePref } from "./hooks.js";

export { toast };

export function Toaster({ position = "bottom-center", offset }) {
  const [pref] = useThemePref();
  return (
    <Sonner
      theme={pref}
      position={position}
      offset={offset}
      closeButton
      toastOptions={{
        classNames: {
          toast: "!rounded-xl !border-border !bg-card !text-card-foreground !shadow-float !text-[13px]",
          description: "!text-muted-foreground",
        },
      }}
    />
  );
}
