// Deno-side canonical JSON test. Verifies that the same golden vectors
// produce byte-identical output under Deno as under Bun. This is the
// load-bearing cross-runtime parity test (T1 from the eng review).
//
// Run: deno test --allow-read packages/protocol/test-deno/canonical.test.ts

import { canonicalize, canonicalizeWithoutSig } from "../src/canonical.ts";

type Vector = { name: string; input: unknown; canonical: string };

const vectorsText = await Deno.readTextFile(
  new URL("../test/fixtures/canonical/vectors.json", import.meta.url),
);
const vectors: Vector[] = JSON.parse(vectorsText);

for (const v of vectors) {
  Deno.test(`canonical JSON — ${v.name}`, () => {
    const actual = canonicalize(v.input);
    if (actual !== v.canonical) {
      throw new Error(
        `Deno canonical output diverges from golden vector:\n` +
          `  expected: ${v.canonical}\n` +
          `  actual:   ${actual}`,
      );
    }
  });
}

Deno.test("canonicalizeWithoutSig removes top-level sig only (Deno)", () => {
  const doc = { type: "promise", name: "1 logo", sig: "abc123" };
  const expected = `{"name":"1 logo","type":"promise"}`;
  const actual = canonicalizeWithoutSig(doc);
  if (actual !== expected) {
    throw new Error(`expected ${expected}, got ${actual}`);
  }
});
