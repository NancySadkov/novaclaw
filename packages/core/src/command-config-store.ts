export * as CommandConfigStore from "./command-config-store"

import { eq } from "drizzle-orm"
import { Cause, Context, Effect, Exit, Layer, Schema, SchemaIssue } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { CommandConfigTable } from "./command-config/sql"
import { ConfigCommand } from "./config/command"

/**
 * Format an Effect decode failure into a short human-readable reason — the same shape
 * `settings-config-seed.ts` uses, so every "a stored config row could not be read" notice reads
 * the same way to a user. Duplicated per store on purpose: these four layered stores are
 * deliberate copies of one template (see the header comment) and share no helper module.
 */
function decodeFailureReason(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause)
  if (Schema.isSchemaError(error)) {
    const messages = SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map((issue) => issue.message)
    if (messages.length > 0) return messages.join("; ")
  }
  return String(error)
}

/**
 * The trace an operator can find: a WARN in the instance log (Developer mode → Debug app → error
 * log), naming every row that was dropped and why — the same reporting `config.ts` does for an
 * unreadable settings row. Deduped against `reported` for the life of the layer so a caller that
 * reads per-turn cannot turn one corrupt row into a log flood.
 */
const warnUnreadable = (reported: Set<string>, skipped: readonly string[]) =>
  Effect.suspend(() => {
    const fresh = skipped.filter((line) => !reported.has(line))
    if (fresh.length === 0) return Effect.void
    for (const line of fresh) reported.add(line)
    const one = fresh.length === 1
    return Effect.logWarning(
      `${fresh.length} stored command${one ? "" : "s"} failed validation and ${one ? "is" : "are"} UNAVAILABLE — ` +
        `every other command still loaded. Fix or delete the row (Registry app → command_config):\n` +
        fresh.map((line) => `  - ${line}`).join("\n"),
    )
  })

// Config→SQLite step 3: the instance-wide, SQLite-backed source of truth for config-file-borne
// command definitions (the catalog/agent-store template). Global so every directory — including the
// shared scratch dir — resolves the same commands. jsonc becomes import/export only: the
// config-command plugin seeds this store from an existing novaclaw.jsonc on first boot
// (transitional — removed in migration step 8). Markdown commands stay filesystem-walked (D2).
export interface Interface {
  /** Every stored command's config layers, keyed by command name (apply in order to merge). */
  readonly commands: () => Effect.Effect<Record<string, ConfigCommand.Info[]>>
  /** Insert or replace the full ordered layer list for one command. */
  readonly setLayers: (name: string, layers: ConfigCommand.Info[]) => Effect.Effect<void>
  /** Remove one command's stored config. */
  readonly removeCommand: (name: string) => Effect.Effect<void>
  /** True when no commands are stored (used to gate the one-time jsonc seed). */
  readonly isEmpty: () => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CommandConfigStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    // PER-ROW, and never `decodeUnknownSync`. Sync decode THROWS, and this runs inside an
    // `Effect.fn` on a `makeGlobalNode` service that every location boot resolves — so one
    // malformed `layers` blob was a DEFECT that killed `commands()` outright, i.e. every command
    // vanished and the boot died with it. Standing decision 3: a read never destroys, and an
    // unavailable subsystem NAMES itself instead of rendering empty.
    //
    // Granularity is the ROW, not the individual layer: layers merge in order and later layers
    // override earlier ones, so silently dropping one layer out of the middle yields a DIFFERENT
    // command than the user configured. Quietly wrong is worse than honestly missing — so an
    // unreadable row means that ONE command is unavailable and said so, and every other row
    // still loads.
    const decodeLayers = Schema.decodeUnknownExit(Schema.Array(ConfigCommand.Info))
    const reported = new Set<string>()

    return Service.of({
      commands: Effect.fn("CommandConfigStore.commands")(function* () {
        const rows = yield* db.select().from(CommandConfigTable).all().pipe(Effect.orDie)
        const result: Record<string, ConfigCommand.Info[]> = {}
        const skipped: string[] = []
        for (const row of rows) {
          const decoded = decodeLayers(row.layers)
          if (Exit.isSuccess(decoded)) {
            result[row.name] = [...decoded.value]
            continue
          }
          skipped.push(`${row.name}: ${decodeFailureReason(decoded.cause)}`)
        }
        if (skipped.length > 0) yield* warnUnreadable(reported, skipped)
        return result
      }),
      setLayers: Effect.fn("CommandConfigStore.setLayers")(function* (name, layers) {
        yield* db
          .insert(CommandConfigTable)
          .values({ name, layers })
          .onConflictDoUpdate({ target: CommandConfigTable.name, set: { layers } })
          .run()
          .pipe(Effect.orDie)
      }),
      removeCommand: Effect.fn("CommandConfigStore.removeCommand")(function* (name) {
        yield* db.delete(CommandConfigTable).where(eq(CommandConfigTable.name, name)).run().pipe(Effect.orDie)
      }),
      isEmpty: Effect.fn("CommandConfigStore.isEmpty")(function* () {
        const row = yield* db.select().from(CommandConfigTable).get().pipe(Effect.orDie)
        return row === undefined
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
