import { Config } from "@/config/config"
import { Config as ConfigV2 } from "@novaclaw/core/config"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { mutateConfig } from "./config-mutation"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const configSvc = yield* Config.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      // The success schema is the `Config.Info` Schema.Class, so the response must be a class
      // INSTANCE — the service returns a plain merged object (with the derived `plugin_origins`),
      // so decode it (excess `plugin_origins` is ignored) before returning.
      // Config→SQLite step 7: overlay the store-backed keys so per-location consumers
      // (`sync().data.config` — the composer's strict/tuning global defaults) read the same
      // values the runtime's synthetic document serves.
      const base = (yield* configSvc.get()) as Record<string, unknown>
      return Schema.decodeUnknownSync(ConfigV2.Info)(yield* ConfigStoreWrite.overlay(base))
    })

    // Config→SQLite step 9: settings are instance-wide, so the instance-scoped update routes
    // through the same store router as the global one (there is no per-instance config.json
    // anymore). `invalidate()` refreshes the service's cached store view.
    //
    // ─── v0.2.0-prep B7, FINAL STEP: a settings change is not a reboot (ruling 3) ─────────────────
    //
    // This handler used to end with `markInstanceForDisposal(...)`, which deferred an
    // `InstanceStore.dispose` to the post-response middleware: the instance was dropped from the
    // store, every `InstanceState` cache in the process was invalidated, and the whole per-location
    // layer graph was released. **Saving a preference killed the user's terminals, failed every
    // pending permission ask, and shut down every MCP child**, then paid a ~1 s location boot on the
    // next request. That was the only reason an edited setting applied at all — root cause S1: every
    // runtime-editable value was snapshotted at layer-build time, so the only repair was destroying
    // the layer graph.
    //
    // It is gone because the four cures that replace it are all in the tree, each read-through or
    // re-materialising at the write itself rather than at a rebuild:
    //   · tier-1   — `Config.entries()` reads through to the store; the runner derives harness config
    //                per turn, so every plain settings key is live with no invalidation at all.
    //   · tier-2a  — `tool/profile.ts` gates on a live per-turn availability predicate instead of a
    //                layer-scope snapshot.
    //   · tier-2b  — `filesystem/watcher.ts` RE-SUBSCRIBES on a `watcher.ignore` change (an OS
    //                subscription cannot be read through), fired from `ConfigStoreWrite.apply`.
    //   · tier-2c+ — the per-domain reload registry in `ConfigStoreWrite.apply` re-materialises the
    //                domains that are a built graph: agents · commands · references · skills, and
    //                (added with this step) the CATALOG, i.e. providers/models plus the integrations
    //                derived from them. Without that last one, dropping the teardown would have
    //                silently broken AGENTS.md's self-healing example — one PATCH fixing a moved
    //                provider URL, no restart. Measured, then fixed:
    //                `packages/core/test/config-catalog-reload.test.ts`.
    //
    // `Offline.reload()` rides the same chokepoint (A3), so the airgap applies immediately too.
    //
    // Tier 3 now uses that same ordered reload registry for Config, Formatter and MCP; the latter
    // reconciles connections instead of destroying every child. The shrink-only restart ledger has
    // one explicit exception: `plugins`, because ESM cannot unload an in-process module and ruling 5
    // schedules that loader for deletion rather than a hot-reload mechanism. `GET /config` always
    // answers directly from `ConfigStoreWrite.overlay` regardless.
    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      return yield* mutateConfig({ request: ctx.request, payload: ctx.payload, readView: "instance" })
    })

    return handlers.handle("get", get).handle("update", update)
  }),
)
