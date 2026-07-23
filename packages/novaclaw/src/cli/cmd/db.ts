import type { Argv } from "yargs"
import { Database } from "@novaclaw/core/database/database"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { effectCmd } from "../effect-cmd"

// Headless-only (one-UI rule, todo tie-break #3): the interactive sqlite3 shell died with the
// TUI — interactive browsing lives in the Developer-mode Registry app; this runs one query.
const QueryCommand = effectCmd({
  command: "$0 [query]",
  describe: "run a SQL query against the instance database",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: "SQL query to execute",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "Output format",
      })
  },
  handler: Effect.fn("Cli.db.query")(function* (args: { query?: string; format: string }) {
    const query = args.query as string | undefined
    if (!query) {
      console.log("Pass a SQL query, e.g. `nova-cli db \"select count(*) from session\"`.")
      console.log("For interactive browsing use the Registry app (Developer mode) in the NovaClaw UI.")
      return
    }
    const { db } = yield* Database.Service
    const result = yield* db.all<Record<string, unknown>>(sql.raw(query)).pipe(Effect.orDie)
    if (args.format === "json") console.log(JSON.stringify(result, null, 2))
    else if (result.length > 0) {
      const keys = Object.keys(result[0])
      console.log(keys.join("\t"))
      for (const row of result) console.log(keys.map((key) => row[key]).join("\t"))
    }
  }),
})

const PathCommand = effectCmd({
  command: "path",
  describe: "print the database path",
  instance: false,
  handler: Effect.fn("Cli.db.path")(function* () {
    console.log(Database.path())
  }),
})

export const DbCommand = effectCmd({
  command: "db",
  describe: "database tools",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs.command(QueryCommand).command(PathCommand).demandCommand()
  },
  handler: Effect.fn("Cli.db")(function* () {}),
})
