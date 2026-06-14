// Bank Alice — Edge Function entrypoint.
// Shared bank logic in ../_shared/bank/server.ts; this file just names this bank.

import { startBank } from "../_shared/bank/server.ts";

startBank({ name: "bank-alice" });
