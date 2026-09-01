export * as SettingsConfigMigrate from "./settings-config-migrate"

import { Effect } from "effect"
import { Log } from "@novaclaw/schema/log"
import { isRecord } from "@novaclaw/schema/record"
import type { Commands } from "./session/runner/quality"
import { QualityProvision } from "./session/runner/quality-provision"
import { SettingsConfigStore } from "./settings-config-store"

/**
 * **Data repairs to rows that are already in the settings store.**
 *
 * The sibling `settings-config-seed.ts` IMPORTS a config document into the store on first boot and
 * is `isEmpty`-gated, so it never sees an existing user's data. This module is the other half: it
 * runs on EVERY boot, over whatever is already stored, and repairs values that a later rule change
 * made unusable. It is not a schema migration — no table, column or key set changes here; the
 * strict-ordered SQL migrations live in `database/migration/`.
 *
 * ── the rule every migration in this file follows ───────────────────────────────────────────────
 *
 * 1. **Idempotent.** It runs on every boot, so a second pass over its own output must be a no-op.
 *    That is asserted, not assumed (`test/quality-command-migration.test.ts`).
 * 2. **Never silent.** A repair that changes a user's setting without telling them is v0.2.0
 *    ruling 2 wearing a different hat — the user is left with a setting that is not what they
 *    typed and no way to learn why. Every repair emits its own complete English sentence.
 * 3. **Best-effort.** Boot must survive a failure here; the caller (`config-seed-startup.ts`)
 *    ignores errors, exactly as it does for the seeds.
 *
 * ── migration 1 (2026-08-07): the QE file-rendered slots ────────────────────────────────────────
 *
 * `QualityProvision.FILE_RENDERED_SLOTS` stopped the manifest scan claiming `check`/`syntax` with
 * whole-project commands — because `Quality.renderCommand` appends the written file's path, and
 * `cargo check --quiet "src/lib.rs"` exits 1 with `unexpected argument` (measured 2026-07-30). The
 * rule was tightened and **no migration was written**, so every instance provisioned before it kept
 * reporting that nonexistent fault on every single write, unfixable from the UI. This is that
 * migration. The relocate-don't-drop reasoning lives with the table, in
 * `session/runner/quality-provision.ts`.
 */

/**
 * Repair `quality.commands` in the settings store. Returns the user-facing notes, one per repaired
 * slot — empty when there was nothing to do, which is the overwhelmingly common case.
 *
 * ⚠️ The whole `quality` value is re-written, spread over the stored object, because a repair
 * DELETES a key: a merge-patch would leave the stale `check` in place and the migration would be a
 * silent no-op that looks like it ran. `enabled`, `cadence` and `testTimeout` are carried through
 * untouched.
 */
export const migrateQualityCommands = Effect.fn("SettingsConfigMigrate.migrateQualityCommands")(function* () {
  const store = yield* SettingsConfigStore.Service
  const quality = (yield* store.all()).quality
  if (!isRecord(quality) || !isRecord(quality.commands)) return [] as string[]

  const { commands, repairs } = QualityProvision.migrateCommands(quality.commands as Commands)
  if (repairs.length === 0) return [] as string[]

  yield* store.set("quality", { ...quality, commands })
  const notes = repairs.map((repair) => repair.note)
  yield* Log.event("config.settings.migrated", { "config.notice": notes.join("\n") })
  return notes
})

/** Every data repair, in order. Best-effort per migration: one failure must not skip the rest. */
export const migrateAll = Effect.fn("SettingsConfigMigrate.migrateAll")(function* () {
  return yield* migrateQualityCommands().pipe(Effect.catchCause(() => Effect.succeed([] as string[])))
})
