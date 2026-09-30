export const process = globalThis.process ?? { env: {}, versions: {}, platform: "browser", cwd: () => "/", nextTick: (f, ...a) => queueMicrotask(() => f(...a)), emitWarning() {} };
