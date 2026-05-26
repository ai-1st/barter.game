// GENERATED — do not edit. Source: packages/protocol/src/canonical.ts
// Re-sync with: bun run scripts/sync-protocol.ts

// RFC 8785 JSON Canonicalization Scheme (JCS).
//
// Cross-runtime: must produce byte-identical output under Bun, Node, Deno, and
// browser. Every signature in the protocol is `ed25519(canonical(doc))` so any
// divergence between runtimes silently breaks cross-bank verification.
//
// Implementation:
//   1. Sort object keys lexicographically by Unicode code point (UTF-16 units,
//      per RFC 8785 § 3.2.3).
//   2. Numbers serialized via ECMAScript ToString(Number) — the algorithm in
//      ECMA-262 §6.1.6.1.13, which JavaScript's String(n) implements natively.
//   3. Strings serialized with the minimal-escape policy in RFC 8785 § 3.2.2.2:
//      only escape control chars, ", and \\. Everything else stays UTF-8.
//   4. null / true / false / arrays / nested objects recurse.
//
// We deliberately do NOT depend on json-canonicalize the npm package, because
// Deno's npm: shim has historically produced slightly different output for
// edge-case numbers (negative zero, very small floats). Owning ~80 LOC of
// canonical JSON is cheaper than debugging that.

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

export function canonicalize(value: unknown): string {
  return serialize(value as JsonValue);
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

/**
 * Remove the top-level `sig` field from a doc and return its canonical form.
 * Used when computing the hash a signature commits to.
 */
export function canonicalizeWithoutSig(doc: unknown): string {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return canonicalize(doc);
  }
  const { sig: _sig, ...rest } = doc as Record<string, unknown>;
  return canonicalize(rest);
}

function serialize(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return serializeNumber(value);
  if (typeof value === "string") return serializeString(value);
  if (Array.isArray(value)) {
    return "[" + value.map(serialize).join(",") + "]";
  }
  if (typeof value === "object") {
    return serializeObject(value);
  }
  throw new TypeError(`canonicalize: unsupported value type: ${typeof value}`);
}

function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new TypeError(`canonicalize: non-finite number: ${n}`);
  }
  // ECMAScript ToString(Number) per RFC 8785 § 3.2.2.3.
  // String(n) implements ECMA-262 §6.1.6.1.13 — same in all JS runtimes.
  // -0 collapses to 0 per RFC 8785.
  if (Object.is(n, -0)) return "0";
  return String(n);
}

function serializeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x09) out += "\\t";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0d) out += "\\r";
    else if (c < 0x20) {
      out += "\\u" + c.toString(16).padStart(4, "0");
    } else {
      // RFC 8785 § 3.2.2.2: emit BMP non-control chars literally; surrogates
      // get serialized by the iteration since we walk char codes (UTF-16 code
      // units), and the TextEncoder downstream handles surrogate pairs.
      out += s[i];
    }
  }
  out += '"';
  return out;
}

function serializeObject(obj: { [k: string]: JsonValue }): string {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort(compareUtf16);
  let out = "{";
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) out += ",";
    const k = keys[i]!;
    out += serializeString(k) + ":" + serialize(obj[k]!);
  }
  out += "}";
  return out;
}

/** UTF-16 code-unit comparison, as RFC 8785 § 3.2.3 requires. */
function compareUtf16(a: string, b: string): number {
  // JavaScript's default String comparison IS UTF-16 code-unit order, which
  // matches RFC 8785's requirement. We name the function for clarity and to
  // make the cross-runtime intent explicit.
  return a < b ? -1 : a > b ? 1 : 0;
}
