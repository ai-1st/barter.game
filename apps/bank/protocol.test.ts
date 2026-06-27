import { assertEquals, assertNotEquals } from 'jsr:@std/assert';
import { genKeyPair, publicKeyOf, signDoc, verifyDoc, hashDoc, canonicalize } from '@barter.game/protocol';

Deno.test('genKeyPair produces distinct keypairs', () => {
  const a = genKeyPair();
  const b = genKeyPair();
  assertNotEquals(a.pubkeyBase58, b.pubkeyBase58);
  assertEquals(a.privateKey.length, 32);
});

Deno.test('publicKeyOf derives the same pubkey', () => {
  const kp = genKeyPair();
  const derived = publicKeyOf(kp.privateKey);
  assertEquals(derived.pubkeyBase58, kp.pubkeyBase58);
});

Deno.test('sign and verify a doc', () => {
  const kp = genKeyPair();
  const doc = { type: 'voucher', pubkey: kp.pubkeyBase58, ulid: '01J9Z00000000000000000000', bank: kp.pubkeyBase58, name: 'test' };
  const sig = signDoc(doc, kp.privateKey);
  assertEquals(verifyDoc(doc, sig, kp.pubkeyBase58), true);
  assertEquals(verifyDoc({ ...doc, name: 'tampered' }, sig, kp.pubkeyBase58), false);
});

Deno.test('hashDoc is deterministic and sensitive to changes', () => {
  const doc = { type: 'voucher', pubkey: '6bUGxYxqyXkxGLFx9Do8scGFnxpJqzUuKegEJuRXproJ', ulid: '01J9Z00000000000000000000', bank: '6bUGxYxqyXkxGLFx9Do8scGFnxpJqzUuKegEJuRXproJ', name: 'test' };
  const h1 = hashDoc(doc);
  const h2 = hashDoc({ ...doc });
  const h3 = hashDoc({ ...doc, name: 'TEST' });
  assertEquals(h1, h2);
  assertNotEquals(h1, h3);
});

Deno.test('canonicalize drops undefined keys', () => {
  assertEquals(canonicalize({ a: 1, b: undefined, c: 'x' }), '{"a":1,"c":"x"}');
});
