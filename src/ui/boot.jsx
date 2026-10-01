import React from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import { TooltipProvider } from "./overlay.jsx";

// Every extension page mounts through here so they share motion settings (respecting the OS
// "reduce motion" preference) and tooltip behaviour.
export function mount(App) {
  createRoot(document.getElementById("root")).render(
    <MotionConfig reducedMotion="user">
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </MotionConfig>,
  );
}
