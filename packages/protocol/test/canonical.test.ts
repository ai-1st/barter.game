// Bun-side canonical JSON test. Runs the same golden vectors that the
// Deno-side test runs (test-deno/canonical.test.ts). Any divergence between
// runtimes will surface here at CI time, not at W3 cross-bank debug time.

import { describe, expect, test } from "bun:test";
import { canonicalize, canonicalizeWithoutSig } from "../src/canonical.ts";
import vectors from "./fixtures/canonical/vectors.json" with { type: "json" };

type Vector = { name: string; input: unknown; canonical: string };

describe("canonical JSON — golden vectors", () => {
  for (const v of vectors as Vector[]) {
    test(v.name, () => {
      expect(canonicalize(v.input)).toBe(v.canonical);
    });
  }
});

describe("canonicalizeWithoutSig", () => {
  test("removes top-level sig field", () => {
    const doc = { type: "promise", name: "1 logo", sig: "abc123" };
    expect(canonicalizeWithoutSig(doc)).toBe(`{"name":"1 logo","type":"promise"}`);
  });

  test("does not remove nested sig fields", () => {
    const doc = { type: "tx", inner: { sig: "kept" } };
    expect(canonicalizeWithoutSig(doc)).toBe(
      `{"inner":{"sig":"kept"},"type":"tx"}`
    );
  });

  test("returns canonical form when input is not an object", () => {
    expect(canonicalizeWithoutSig(null)).toBe("null");
    expect(canonicalizeWithoutSig(42)).toBe("42");
  });
});

describe("canonical — error cases", () => {
  test("throws on non-finite numbers", () => {
    expect(() => canonicalize({ n: Infinity })).toThrow();
    expect(() => canonicalize({ n: NaN })).toThrow();
  });
});
