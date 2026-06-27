import { assertEquals } from 'jsr:@std/assert';
import { canonicalize, canonicalizeWithoutSig } from '../src/index.ts';
import vectors from '../test/fixtures/canonical/vectors.json' with { type: 'json' };

type Vector = { name: string; input: unknown; canonical: string };

for (const v of vectors as Vector[]) {
  Deno.test(`canonical vector: ${v.name}`, () => {
    assertEquals(canonicalize(v.input), v.canonical);
  });
}

Deno.test('canonicalizeWithoutSig removes top-level sig', () => {
  const doc = { type: 'voucher', name: '1 logo', sig: 'abc123' };
  assertEquals(
    canonicalizeWithoutSig(doc),
    '{"name":"1 logo","type":"voucher"}',
  );
});

Deno.test('canonicalizeWithoutSig keeps nested sig', () => {
  const doc = { type: 'tx', inner: { sig: 'kept' } };
  assertEquals(
    canonicalizeWithoutSig(doc),
    '{"inner":{"sig":"kept"},"type":"tx"}',
  );
});
