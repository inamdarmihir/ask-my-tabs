// LangChain/LangGraph reference `process` at load time. Extension pages have none, so provide a
// minimal one. Must be the FIRST import of the bundle entry so it runs before those modules.
if (typeof globalThis.process === "undefined") {
  globalThis.process = { env: {}, versions: {}, platform: "browser", cwd: () => "/", nextTick: (f, ...a) => queueMicrotask(() => f(...a)), emitWarning() {} };
}
