import { DbRegistry } from "@novaclaw/core/db-registry"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { DbRegistryView } from "@novaclaw/core/db-registry-view"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError } from "../errors"

// Registry handlers — thin lowering of the HTTP contract onto the core DbRegistry module.
// RegistryError (unknown table / no editable columns) becomes the API's standard 400 shape.
//
// ── the tier this surface acts at, and why it is not read off the request ────────────────────────
//
// 🔴 **These five routes used to act at the unrestricted `developer` tier on every call.** All three
// write routes omitted `writer`, so `DbRegistry.assertWritable`'s default applied, and `rows`
// returned stored credentials verbatim. The `registry` TOOL passes `writer: "agent"` and redacts its
// page — so the gate sat on the tool rather than on the resource, and one `curl` at the same port
// was the whole bypass: an agent denied a privileged `configure` card could write the
// `runtime_setting` row directly, or read `credential.value` and every provider `Authorization`
// header back out of `GET /registry/rows`. Ruling 4's per-key config privilege model
// (`notes/reports/decisions-v0.2.0.md` §4) is exactly what that circumvents.
//
// ⚠️ **HTTP cannot say WHO is asking, and nothing in this tree pretends otherwise.** There is no
// per-request caller attribution anywhere on the instance API: the app, the SDK, the CLI, a peer and
// `curl` from an agent's own shell are one anonymous caller behind one credential, `mutation-origin`
// deliberately admits a missing `Origin` because every non-browser caller sends none, and ruling 4
// explicitly rules OUT giving the agent's shell a self URL + token that could be recognised. The
// neighbouring `/memory/*` handlers act as OWNER on the same reasoning this defect falsifies — *"an
// agent cannot construct this, because its access comes from the session it runs in"* — which is
// true only while the agent has no shell. So an in-band marker (a header, a query flag) would be a
// claim the caller makes about itself, and the caller we are guarding against writes the request.
//
// **What the tier is decided by instead: the instance's own `expertise` setting** — the same gate
// the Registry app is behind (`packages/app/src/apps/builtins.tsx`, `minLevel: "developer"`), so the
// server now enforces what the launcher tile already implied and the two cannot disagree. It is a
// consequential-tier config key (`config-tier.ts`), so an agent cannot quietly flip it to widen its
// own reach — that write costs a consent card, which is precisely ruling 4 working. Anything other
// than `developer` FAILS CLOSED to the agent tier, including the absent value a default install has.
//
// ⚠️ **What it does NOT claim.** This is a tier, not an identity: while a human IS in Developer mode
// every caller on the port gets the developer tier, this surface included. That is ruling 5's trust
// boundary as written — the instance is the boundary, and a Developer-mode human editing their own
// machine is the Registry app's whole purpose — but it is a deliberately weaker statement than "the
// human asked for this", and it should not be read as the stronger one.
//
// ⚠️ **One redactor, one table list.** The agent tier reuses `DbRegistryTool`'s own `redactPage` and
// `configRoutes` rather than restating them here: a second copy would drift from the ledger test
// that pins those against the live schema, and the whole point is that both doors answer alike.
export const registryHandlers = HttpApiBuilder.group(InstanceHttpApi, "registry", (handlers) =>
  Effect.gen(function* () {
    const mapError = <A, R>(effect: Effect.Effect<A, DbRegistry.RegistryError, R>) =>
      effect.pipe(
        Effect.catchTag("DbRegistry.RegistryError", (error) =>
          Effect.fail(new InvalidRequestError({ message: error.message })),
        ),
      )

    const settings = yield* SettingsConfigStore.Service

    /**
     * The tier this request acts at.
     *
     * ⚠️ Read from the INSTANCE-WIDE settings store rather than through `Config.Service`, for two
     * reasons that point the same way. This group declares no `InstanceContextMiddleware`, so there
     * is no `InstanceRef` here and `Config.get()` dies on the first call — and it should not be
     * reached for anyway: the database these routes edit is global, one per instance, with
     * `directory` on the endpoints being nothing but routing (see `groups/registry.ts`). A
     * per-directory read for a global resource could answer two ways about one table.
     *
     * Read per call, never cached, so switching Developer mode in Settings applies to the next
     * request instead of the next boot — the property `config-store-write` exists to guarantee.
     */
    const writerTier = Effect.fn("RegistryHttpApi.writer")(function* () {
      const stored = yield* settings.all()
      const tier: DbRegistry.Writer = stored.expertise === "developer" ? "developer" : "agent"
      return tier
    })

    return handlers
      .handle(
        "tables",
        Effect.fn("RegistryHttpApi.tables")(function* () {
          // Table names and row counts are our own schema, never a stored value — the same line
          // `DbRegistryTool` draws when it declines to frame them.
          return yield* DbRegistry.tables()
        }),
      )
      .handle(
        "rows",
        Effect.fn("RegistryHttpApi.rows")(function* (ctx) {
          const writer = yield* writerTier()
          // FAIL CLOSED before a byte is read, exactly as the tool does: a config-backed table with
          // no redaction route is one whose secrets nothing here knows how to find.
          if (
            writer === "agent" &&
            DbRegistry.configBackedTables().has(ctx.query.table) &&
            !DbRegistryView.configRoutes().has(ctx.query.table)
          )
            return yield* new InvalidRequestError({
              message:
                `"${ctx.query.table}" holds configuration and there is no redaction route for it, so it ` +
                `will not be read back at this tier. Use \`configure\` — {"op":"read"} shows what this ` +
                `instance stores, with credentials redacted.`,
            })
          const page = yield* mapError(
            DbRegistry.rows({ table: ctx.query.table, limit: ctx.query.limit, offset: ctx.query.offset }),
          )
          return writer === "agent" ? DbRegistryView.redactPage(page) : page
        }),
      )
      .handle(
        "updateRow",
        Effect.fn("RegistryHttpApi.updateRow")(function* (ctx) {
          const writer = yield* writerTier()
          yield* mapError(
            DbRegistry.updateRow({
              table: ctx.payload.table,
              rowid: ctx.payload.rowid,
              values: ctx.payload.values,
              writer,
            }),
          )
          return true
        }),
      )
      .handle(
        "insertRow",
        Effect.fn("RegistryHttpApi.insertRow")(function* (ctx) {
          const writer = yield* writerTier()
          yield* mapError(DbRegistry.insertRow({ table: ctx.payload.table, values: ctx.payload.values, writer }))
          return true
        }),
      )
      .handle(
        "deleteRow",
        Effect.fn("RegistryHttpApi.deleteRow")(function* (ctx) {
          const writer = yield* writerTier()
          yield* mapError(DbRegistry.deleteRow({ table: ctx.payload.table, rowid: ctx.payload.rowid, writer }))
          return true
        }),
      )
  }),
)
