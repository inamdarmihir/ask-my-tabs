import test from "node:test";
import assert from "node:assert/strict";
import { buildScopeFilter } from "../../src/lib/filters.js";

test("buildScopeFilter returns undefined for an empty scope (search everything)", () => {
  assert.equal(buildScopeFilter({}), undefined);
  assert.equal(buildScopeFilter(), undefined);
});

test("buildScopeFilter scopes to a working set's source keys with a match-any clause", () => {
  const filter = buildScopeFilter({ sourceKeys: ["a", "b"] });
  assert.deepEqual(filter, { must: [{ key: "sourceKey", match: { any: ["a", "b"] } }] });
});

test("buildScopeFilter combines domain and date-range filters", () => {
  const filter = buildScopeFilter({ domain: "example.com", indexedAfter: 100, indexedBefore: 200 });
  assert.deepEqual(filter, {
    must: [
      { key: "domain", match: { value: "example.com" } },
      { key: "indexedAt", range: { gte: 100, lte: 200 } },
    ],
  });
});

test("buildScopeFilter is identical in shape regardless of caller (working-set vs library scope)", () => {
  const workingSetFilter = buildScopeFilter({ sourceKeys: ["x"] });
  const libraryFilter = buildScopeFilter({ domain: "x.com" });
  assert.ok(Array.isArray(workingSetFilter.must));
  assert.ok(Array.isArray(libraryFilter.must));
});
