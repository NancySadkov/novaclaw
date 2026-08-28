import { describe, expect, test } from "bun:test"

import { strayServerLabel, KEEP_ENV, sweepStrayServers } from "./stray-servers"
import { heavyJobLabels } from "./heavy-guard"

/**
 * The one thing this sweep must never do is kill somebody else's build or suite.
 *
 * 🔴 That is not hypothetical: on 2026-08-14 a pid printed by the heavy guard was read as a stray and
 * killed with `taskkill /T` — it was a concurrent Claude session's gate run, and it took that run's
 * shards and migration check with it. These tests hold the boundary still.
 */

/** Command lines seen on this machine, copied from `Get-CimInstance Win32_Process` output. */
const SERVERS = [
  "C:\\Users\\nangl\\AppData\\Roaming\\npm\\node_modules\\bun\\bin\\bun.exe run --cwd packages/novaclaw --conditions=browser src/index.ts serve --port 4098",
  "C:\\Users\\nangl\\AppData\\Roaming\\npm\\node_modules\\bun\\bin\\bun.exe --conditions=browser C:\\Users\\nangl\\d\\code\\llm\\novaclaw\\packages\\novaclaw\\src\\index.ts",
  "bun.exe --cwd packages/app dev",
]

/** One per heavy pattern — the set that must survive a sweep untouched. */
const HEAVY = [
  "bun.exe x electron-builder --win --config electron-builder.config.ts",
  "bun.exe x electron-vite build",
  "bun.exe packages/desktop/scripts/prebuild.ts",
  "bun.exe packages/novaclaw/script/build.ts",
  "bun.exe run script/test.ts --only=core",
  "node.exe C:\\repo\\node_modules\\.bin\\tsgo -b",
]

describe("stray server sweep", () => {
  test("recognises the backends this repo actually leaves behind", () => {
    for (const commandLine of SERVERS) expect(strayServerLabel("bun.exe", commandLine)).toBeString()
  })

  test("NEVER matches anything the heavy guard names", () => {
    for (const commandLine of HEAVY) {
      // Precondition: the sample really is a heavy job, or this test proves nothing at all.
      expect(heavyJobLabels("bun.exe", commandLine).length).toBeGreaterThan(0)
      expect(strayServerLabel("bun.exe", commandLine)).toBeUndefined()
    }
  })

  test("only bun and node — not an editor or a shell that mentions the path", () => {
    const serve = SERVERS[0]!
    expect(strayServerLabel("code.exe", serve)).toBeUndefined()
    expect(strayServerLabel("powershell.exe", serve)).toBeUndefined()
    expect(strayServerLabel("NovaClaw.exe", serve)).toBeUndefined()
  })

  test("does not match its own probe", () => {
    expect(strayServerLabel("bun.exe", "bun.exe script/lib/stray-servers.ts --cwd packages/novaclaw")).toBeUndefined()
    expect(
      strayServerLabel("powershell.exe", "powershell -Command Get-CimInstance Win32_Process ... packages/novaclaw"),
    ).toBeUndefined()
  })

  test("an unrelated bun is left alone", () => {
    expect(strayServerLabel("bun.exe", "bun.exe run --cwd packages/kb some-other-thing.ts")).toBeUndefined()
    expect(strayServerLabel("bun.exe", "bun.exe install")).toBeUndefined()
  })

  test("running something ELSE from the server's directory is not a server", () => {
    /**
     * 🔴 The near miss that a first draft got wrong. `--cwd packages/novaclaw` alone matched these,
     * and neither is spelled the way `heavyJobLabels` recognises — so the CLI build would have been
     * swept as an idle backend. Being in the server's directory is not being the server.
     */
    for (const commandLine of [
      "bun.exe run --cwd packages/novaclaw script/build.ts",
      "bun.exe run --cwd packages/novaclaw test",
      "bun.exe run --cwd packages/novaclaw typecheck",
    ]) {
      expect(strayServerLabel("bun.exe", commandLine)).toBeUndefined()
    }
  })

  test(`${KEEP_ENV} skips the sweep entirely`, () => {
    const previous = process.env[KEEP_ENV]
    process.env[KEEP_ENV] = "1"
    try {
      const lines: string[] = []
      const result = sweepStrayServers({ reason: "a test", log: (line) => lines.push(line) })
      expect(result.skipped).toBe(true)
      expect(result.killed).toEqual([])
      // It SAYS it skipped: a guard that silently does nothing is indistinguishable from a broken one.
      expect(lines.join("\n")).toContain(KEEP_ENV)
    } finally {
      if (previous === undefined) delete process.env[KEEP_ENV]
      else process.env[KEEP_ENV] = previous
    }
  })
})
