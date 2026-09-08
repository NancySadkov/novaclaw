import { Persist } from "@/utils/persist"
import type { ServerScope } from "@/utils/server-scope"

/**
 * 🔴 **Where one instance's model preferences live — and why the scope is not optional.**
 *
 * Everything in this store is an answer ABOUT one instance's catalog: which models the user removed,
 * which they marked visible, which they used recently, which variant and tier they assigned. A model
 * id means nothing without the server that serves it, so a store shared across instances lets one
 * instance's rules run over another instance's data — and the `removed` prune is a DESTRUCTIVE
 * write, so that is not a stale read but a silent deletion.
 *
 * It is a function, and exported, so the store and the test that proves the isolation spell the
 * target exactly once between them.
 *
 * ⚠️ `ServerScope.local` resolves to the unscoped key, so the local instance reads back what it
 * wrote before this became per-instance. A remote instance starts from its own empty slate, the same
 * migration `notification` and `layout` already took.
 */
export const modelStoreTarget = (scope: ServerScope) => Persist.serverGlobal(scope, "model", ["model.v1"])
