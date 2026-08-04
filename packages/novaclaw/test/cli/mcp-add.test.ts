import { describe, expect } from "bun:test"
import { Database as Sqlite } from "bun:sqlite"
import { Effect } from "effect"
import path from "path"
import { cliIt } from "../lib/cli-process"

/**
 * `nova-cli mcp add` writes to the instance's SQLite config store — the same place `PATCH /config`
 * and the Settings UI write, and the only place the runtime reads `mcp` from.
 *
 * ⚠️ This suite used to assert on a `novaclaw.json` under the test home, and that assertion was
 * doubly wrong: it read `config.mcp.<name>` while the writer wrote `mcp.servers.<name>` (V2 nested
 * servers when `5a4ede96c` retired the V1 config migrator — this file is `--full`-only, so nothing
 * noticed it go red), and the file it read was one no booted instance would ever consult anyway.
 * v0.2.0-prep B3a replaced the jsonc write; these tests now read the store back out of the database
 * FILE, from this process, after the CLI child has exited — i.e. the cross-process durability claim.
 *
 * `NOVACLAW_DB` is pinned to an absolute path so the assertion does not have to reproduce the
 * channel-suffixed filename `db-path.ts` derives.
 */

/** The `mcp` settings row, as a separate process would read it after the CLI exits. */
function storedMcp(dbFile: string): { servers?: Record<string, unknown> } {
  // Not `readonly: true`: a WAL database needs to create/attach its `-shm` sidecar, which a
  // read-only handle cannot do.
  const db = new Sqlite(dbFile)
  try {
    const row = db.query("select value from runtime_setting where key = 'mcp'").get() as { value: string } | null
    if (!row) throw new Error(`no "mcp" row in ${dbFile} — the CLI wrote nothing durable`)
    return JSON.parse(row.value) as { servers?: Record<string, unknown> }
  } finally {
    db.close()
  }
}

describe("novaclaw mcp add (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "adds a remote server with HTTP headers",
    ({ home, novaclaw }) =>
      Effect.gen(function* () {
        const dbFile = path.join(home, "instance.db")
        const result = yield* novaclaw.spawn(
          [
            "mcp",
            "add",
            "github",
            "--url",
            "https://example.com/mcp",
            "--header",
            "Authorization=Bearer {env:GITHUB_TOKEN}",
            "--header",
            "X-Option=one=two",
          ],
          { env: { NOVACLAW_DB: dbFile } },
        )
        novaclaw.expectExit(result, 0)

        expect(storedMcp(dbFile).servers?.["github"]).toEqual({
          type: "remote",
          url: "https://example.com/mcp",
          headers: {
            Authorization: "Bearer {env:GITHUB_TOKEN}",
            "X-Option": "one=two",
          },
          disabled: false,
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "adds a local server while preserving argv and environment values",
    ({ home, novaclaw }) =>
      Effect.gen(function* () {
        const dbFile = path.join(home, "instance.db")
        const result = yield* novaclaw.spawn(
          [
            "mcp",
            "add",
            "local",
            "--env",
            "API_KEY=secret",
            "--env",
            "VALUE=one=two",
            "--",
            "npx",
            "-y",
            "@example/server",
            "--label",
            "two words",
          ],
          { env: { NOVACLAW_DB: dbFile } },
        )
        novaclaw.expectExit(result, 0)

        expect(storedMcp(dbFile).servers?.["local"]).toEqual({
          type: "local",
          command: ["npx", "-y", "@example/server", "--label", "two words"],
          environment: {
            API_KEY: "secret",
            VALUE: "one=two",
          },
          disabled: false,
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "does not claim a file it no longer writes",
    ({ home, novaclaw }) =>
      Effect.gen(function* () {
        const dbFile = path.join(home, "instance.db")
        const result = yield* novaclaw.spawn(["mcp", "add", "hinted", "--url", "https://example.com/mcp"], {
          env: { NOVACLAW_DB: dbFile },
        })
        novaclaw.expectExit(result, 0)

        // Ruling 2 in its mildest form: the success line has to describe what actually happened.
        // The old one named a jsonc path that nothing would read.
        expect(result.stdout + result.stderr).toContain("added to this instance's config")
      }),
    60_000,
  )
})
