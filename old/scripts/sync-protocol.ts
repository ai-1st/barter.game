#!/usr/bin/env bun
// Sync packages/protocol/src into supabase/functions/_shared/protocol/.
//
// Supabase Edge Functions only ship code from within `functions/`. To reuse
// the protocol package, we copy its sources into `_shared/protocol/` and
// rewrite bare-specifier imports to Deno-friendly `npm:` specifiers.
//
// Run before any `supabase functions deploy` that needs the protocol code.
// `npm run predeploy` hooks this up.

import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/vouchers";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

const SRC = "packages/protocol/src";
const DST = "supabase/functions/_shared/protocol";

// Map bare specifiers used in packages/protocol → Deno-friendly npm: specifiers.
// Keep these versions in lockstep with packages/protocol/package.json AND with
// supabase/functions/bank-alice/deno.json.
const REWRITES: [RegExp, string][] = [
  [/from\s+"@noble\/ed25519"/g, `from "npm:@noble/ed25519@^3.1.0"`],
  [/from\s+"@noble\/hashes\/sha2\.js"/g, `from "npm:@noble/hashes@^2.2.0/sha2.js"`],
  [/from\s+"@noble\/hashes\/sha2"/g, `from "npm:@noble/hashes@^2.2.0/sha2.js"`],
  [/from\s+"@scure\/base"/g, `from "npm:@scure/base@^2.2.0"`],
  [/from\s+"ulid"/g, `from "npm:ulid@^2.3.0"`],
];

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

async function main() {
  // Clean and re-sync to avoid stale files.
  if (existsSync(DST)) await rm(DST, { recursive: true });
  await mkdir(DST, { recursive: true });

  const files = await walk(SRC);
  let rewriteCount = 0;
  for (const src of files) {
    const rel = src.slice(SRC.length + 1);
    const dst = join(DST, rel);
    await mkdir(dirname(dst), { recursive: true });
    let body = await readFile(src, "utf8");
    for (const [re, replacement] of REWRITES) {
      const before = body;
      body = body.replace(re, replacement);
      if (before !== body) rewriteCount++;
    }
    const header =
      `// GENERATED — do not edit. Source: ${src}\n` +
      `// Re-sync with: bun run scripts/sync-protocol.ts\n\n`;
    await writeFile(dst, header + body);
  }
  console.log(`synced ${files.length} files, ${rewriteCount} import rewrites → ${DST}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
