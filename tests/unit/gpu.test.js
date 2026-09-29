// Tests for the WebGPU capability check used by both the embedder (which falls back to WASM)
// and WebLLM (which cannot -- see DECISIONS.md's "Platform support" entry). This is exercised in
// Node, which has no `navigator` global at all, so it also covers the environment this repo's own
// eval harness and CI run in -- these tests confirm the check degrades to "false", not a thrown
// error, when `navigator` is entirely absent.
import test from "node:test";
import assert from "node:assert/strict";
import { hasWebGPU, WEBGPU_UNAVAILABLE_MESSAGE } from "../../src/lib/gpu.js";

// Node 22 ships its own read-only `navigator` global (userAgent-only, no `.gpu`) for Web-standard
// API parity, so it can't be `delete`d or reassigned directly -- it has to be overridden with
// `Object.defineProperty` and restored the same way. That built-in global is itself a real,
// useful case to cover: `hasWebGPU()` must treat "navigator exists but has no gpu" the same way
// in Node (this repo's eval harness/CI) as in a browser without WebGPU.
function withNavigator(value, fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
  return (async () => {
    try {
      return await fn();
    } finally {
      if (original) {
        Object.defineProperty(globalThis, "navigator", original);
      } else {
        delete globalThis.navigator;
      }
    }
  })();
}

test("hasWebGPU() is false in this repo's actual test environment (Node, no navigator.gpu)", async () => {
  assert.equal(await hasWebGPU(), false);
});

test("hasWebGPU() is false when navigator is completely absent", async () => {
  await withNavigator(undefined, async () => {
    assert.equal(await hasWebGPU(), false);
  });
});

test("hasWebGPU() is false when navigator.gpu is missing", async () => {
  await withNavigator({}, async () => {
    assert.equal(await hasWebGPU(), false);
  });
});

test("hasWebGPU() is false when requestAdapter() resolves to null (no usable adapter)", async () => {
  await withNavigator({ gpu: { requestAdapter: async () => null } }, async () => {
    assert.equal(await hasWebGPU(), false);
  });
});

test("hasWebGPU() is false when requestAdapter() throws", async () => {
  await withNavigator(
    {
      gpu: {
        requestAdapter: async () => {
          throw new Error("simulated driver failure");
        },
      },
    },
    async () => {
      assert.equal(await hasWebGPU(), false);
    },
  );
});

test("hasWebGPU() is true when requestAdapter() resolves to a real adapter", async () => {
  await withNavigator({ gpu: { requestAdapter: async () => ({ fakeAdapter: true }) } }, async () => {
    assert.equal(await hasWebGPU(), true);
  });
});

test("the unavailable-WebGPU message names all three desktop OSes rather than singling one out", () => {
  assert.match(WEBGPU_UNAVAILABLE_MESSAGE, /\bWindows\b/);
  assert.match(WEBGPU_UNAVAILABLE_MESSAGE, /\bmacOS\b/);
  assert.match(WEBGPU_UNAVAILABLE_MESSAGE, /\bLinux\b/);
  assert.match(WEBGPU_UNAVAILABLE_MESSAGE, /chrome:\/\/gpu/);
});
