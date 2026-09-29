// Chrome ships WebGPU on desktop (Windows, macOS, Linux, ChromeOS) but whether any given
// *machine* actually exposes it depends on drivers, `chrome://flags` overrides, and OS/enterprise
// policy that can disable GPU access outright -- none of that is specific to this extension, and
// none of it is something code here can fix. What this module CAN do is tell the difference
// between "no WebGPU here" and an unrelated failure, so the popup shows an accurate, actionable
// message instead of a raw stack trace from deep inside transformers.js or WebLLM.
//
// Verified facts (not assumed): `navigator.gpu` is the standard feature-detection surface for
// WebGPU across Chromium builds on every desktop platform (Windows, macOS, Linux) -- it is
// `undefined` when the WebGPU API isn't exposed at all (old Chrome, disabled via policy/flag, or
// a platform that never implements it, e.g. Chrome on Android/iOS). It says nothing about whether
// a *usable* GPU adapter exists behind it -- `requestAdapter()` can still legitimately resolve to
// `null` (e.g. software-only rendering, blocklisted GPU driver), which is the second thing this
// module checks.

export async function hasWebGPU() {
  if (typeof navigator === "undefined" || !navigator.gpu) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter != null;
  } catch {
    return false;
  }
}

// A single, user-facing explanation reused by both the embedder (which can fall back to WASM)
// and WebLLM (which currently cannot -- see src/lib/llm.js). Deliberately platform-neutral: this
// is exactly as likely on a Windows laptop with GPU access disabled by IT policy as it is on a
// Mac with an eGPU asleep, so it never says "this only happens on X".
export const WEBGPU_UNAVAILABLE_MESSAGE =
  "WebGPU isn't available in this Chrome profile (no GPU adapter, or GPU access is disabled by " +
  "flag/policy). This happens the same way on Windows, macOS, and Linux -- it depends on your " +
  "machine and Chrome settings, not on which OS you're running. Check chrome://gpu (look for " +
  "\"WebGPU: Hardware accelerated\"), update graphics drivers, and confirm your organization " +
  "hasn't disabled GPU access via policy.";
