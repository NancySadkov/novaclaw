import { Effect } from "effect"
import { Log } from "@novaclaw/schema/log"
import type { DatabaseMigration } from "../migration"

/**
 * Ruling 5 / dependency step 17 (`notes/reports/decisions-v0.2.0.md`): the `plugins[]` config key
 * and the `npm.add` + `import()` arm it fed are deleted, so the store that held its specs goes too.
 *
 * ⚠️ **The DROP is not the whole migration, and the reason is ruling 2 — a fault is never described
 * falsely.** An upgrading instance may hold rows here: package names its user once wrote into
 * `novaclaw.jsonc`. Those plugins stop loading at this boot, and "silently absent" is the falsest
 * description there is — so each row is NAMED in a warn line before the table goes, with the one
 * remedy that still works. The generated body for this migration was the bare `DROP TABLE`; the
 * read and the log are hand-added on purpose. Do not regenerate this file.
 */
export default {
  id: "20260819032112_drop_plugin_config",
  up(tx) {
    return Effect.gen(function* () {
      const rows = yield* tx.all<{ package: string }>("SELECT `package` FROM `plugin_config`")
      for (const row of rows) yield* Log.event("plugin.config.dropped", { "plugin.package": row.package })
      yield* tx.run(`DROP TABLE \`plugin_config\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
