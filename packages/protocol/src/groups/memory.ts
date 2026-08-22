import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

/**
 * Memory operations on the ONE contract.
 *
 * 🔴 The rest of `/memory/*` is legacy (`novaclaw/src/server/routes/instance/httpapi/groups/memory.ts`)
 * and may only SHRINK — ruling 11, enforced by `sdk/js/test/legacy-path-ledger.test.ts`, which turned
 * red when `erase` was first added there beside its neighbours. It typechecked, it worked, and it
 * would have reviewed as consistent; the ledger is what made the line honest. New memory endpoints
 * belong here.
 */
export const MemoryGroup = HttpApiGroup.make("server.memory").add(
  HttpApiEndpoint.post("memory.erase", "/api/memory/erase", {
    // A COUNT, not a boolean. "It worked" is not auditable, and a store that was already empty must
    // answer 0 rather than imply something happened.
    success: Schema.Number,
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "v2.memory.erase",
      summary: "Erase all memory",
      description:
        "Delete every memory in every scope, for every agent including Nova. Used to run from a clean slate without resetting the install. The confirmation is the caller's responsibility.",
    }),
  ),
)
