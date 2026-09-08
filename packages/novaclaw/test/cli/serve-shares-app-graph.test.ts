import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * `serve` and `web` run under `AppRuntime`, whose `AppLayer` is already alive in the process's
 * shared memo map. Their listener must be built in that SAME map (`ListenOptions.memoMap`), or the
 * process carries two complete instance graphs: two database clients over the live file, two MCP
 * child managers, two event buses. `test/server/httpapi-listen.test.ts` proves the option shares the
 * graph; this file pins that the two commands actually pass it, because the option is opt-in on
 * purpose (a default share turned the server unit red, see `ListenOptions.memoMap`) and an opt-in
 * nobody passes is the defect with a comment on it.
 *
 * Source-scanned: the commands boot a server, which `bun test` cannot do from source on this box.
 */
const CMD = path.resolve(import.meta.dir, "..", "..", "src", "cli", "cmd")

describe("the CLI listeners share the app graph", () => {
  for (const file of ["serve.ts", "web.ts"]) {
    test(`${file} passes the shared memo map to Server.listen`, () => {
      const source = fs.readFileSync(path.join(CMD, file), "utf8")
      expect(source).toContain('import { memoMap } from "@novaclaw/core/effect/memo-map"')
      expect(source).toMatch(/Server\.listen\(\{\s*\.\.\.opts,\s*memoMap\s*\}\)/)
    })
  }
})
