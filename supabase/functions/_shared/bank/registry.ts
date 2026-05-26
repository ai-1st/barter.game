// Bank RPC method registry. Wired by the Edge Function entrypoint.

import type { Registry } from "./rpc.ts";
import { mintPromise } from "./handlers/mint_promise.ts";

export const v1Registry: Registry = {
  mint_promise: mintPromise,
};
