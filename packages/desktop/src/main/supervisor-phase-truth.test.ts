import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * 🔴 AN OWNER MAY NOT REPORT `running` BEFORE IT HAS OBSERVED THE SERVER ANSWER.
 *
 * Measured 2026-09-28 in the packaged app (0.1.81). `SuperviseStatus` had no word for "coming up",
 * so all four local-instance owners reached for `running` from the moment they were constructed —
 * before anything was spawned, let alone bound a port. Commit `df1606bb1` had just made
 * `standalone-server.ts` publish credentials to the renderer at spawn, which is what made the lie
 * reachable: the renderer was already asking "is my instance up?" and was told yes.
 *
 * The result was measured, not inferred. `sidecar-health` (the main process's own probe) succeeded at
 * 9.3 s; the renderer's `client-connected` did not arrive until 38.8 s. In between, the connection
 * gate rendered *"Could not reach Local Server / Retrying automatically..."* against a server
 * answering `/global/health` in 15 ms. Across 52 logged sessions the correlation was exact: every
 * session that logged CORS failures took 38–54 s to connect, every session that logged none took ~7 s.
 *
 * ⚠️ WHY A SOURCE RATCHET AND NOT A BEHAVIOUR TEST. The `running` report is a call into Electron's
 * process model — the owners need `spawn`, a real port and a real child, none of which the unit gate
 * has. The alternative was asserted and rejected: a ratchet that greps for a string is only worth
 * having if it can fail, so each check below names the file it read and asserts the file was read.
 * The stronger proof is the DOM/behaviour one in `server-reachability.test.ts`, which is where the
 * USER-VISIBLE half of this defect is pinned; this file guards the main-process half.
 */

/** Owners that report a phase to the renderer, and the one that must never precede verification. */
const OWNERS = [
  "standalone-server.ts",
  "local-instance.ts",
  "server.ts",
  "desktop-service.ts",
  "deferred-instance.ts",
] as const

const source = (file: string) => {
  const path = join(import.meta.dir, file)
  const raw = readFileSync(path, "utf8")
  expect(raw.length, `${file} must be readable — a moved owner must fail LOUDLY, not pass silently`).toBeGreaterThan(500)
  // Strip comments so prose ABOUT the fix cannot satisfy the check that the fix is absent.
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
}

describe("a supervisor never claims `running` before it has watched the server answer", () => {
  test("the vocabulary can express a start, so nothing is forced to lie to express one", () => {
    const supervise = readFileSync(join(import.meta.dir, "..", "..", "..", "script", "src", "supervise.ts"), "utf8")
    expect(supervise).toContain('phase: "starting"')
    // The renderer's mirror must know the word too, or the phase cannot cross the IPC boundary.
    // `src/main` → `src` → `packages/desktop` → `packages`, hence three `..` and then `app`.
    const platform = readFileSync(
      join(import.meta.dir, "..", "..", "..", "app", "src", "context", "platform.tsx"),
      "utf8",
    )
    expect(platform, "packages/app/src/context/platform.tsx must be readable from here").toContain('phase: "starting"')
  })

  for (const owner of OWNERS) {
    test(`${owner} does not default to \`running\``, () => {
      const code = source(owner)
      // The defect's exact spellings: a status variable initialised to the healthy phase, or a
      // state() that derives `running` from "not stopped" / "not closed" — each answers "is it
      // up?" with yes before anything has been asked.
      for (const lie of [
        /SuperviseStatus\s*=\s*\{\s*phase:\s*"running"\s*\}/,
        /phase:\s*stopping\s*\?\s*"stopped"\s*:\s*"running"/,
        /phase:\s*closed\s*\?\s*"stopped"\s*:\s*"running"/,
        /phase:\s*"stopped"\s*\}\s*:\s*\{\s*phase:\s*"running"\s*\}/,
      ])
        expect(code, `${owner} still answers "is it up?" with yes before verification`).not.toMatch(lie)
    })
  }

  /**
   * The other half of the same defect, and the half a reader is most likely to reintroduce: a
   * `report({ phase: "running" })` bolted straight onto a spawn, claiming "up" off a `ready`
   * message with nothing observed in between. `server.ts` shipped exactly that on both its paths.
   *
   * ⚠️ Spelled as the two sequences it actually was rather than as a window of surrounding text.
   * A proximity heuristic here would be a ratchet nobody could reason about when it fired, which
   * is worse than none — a false positive here trains the next author to delete the test.
   */
  test("no owner claims `running` off a spawn it has not checked", () => {
    for (const owner of OWNERS) {
      const code = source(owner)
      expect(code, `${owner} reports "running" straight after starting its liveness monitor`).not.toMatch(
        /startMonitor\([^)]*\)\s*\n\s*report\(\{\s*phase:\s*"running"\s*\}\)/,
      )
      expect(code, `${owner} reports "running" straight after a respawn message`).not.toMatch(
        /note\("sidecar respawned"\)\s*\n\s*report\(\{\s*phase:\s*"running"\s*\}\)/,
      )
    }
  })

  test("every owner can still say `running`, or this ratchet proves nothing", () => {
    // A file that stopped reporting a phase altogether would satisfy every check above while
    // having removed the feature. `deferred-instance` is the one owner that legitimately never
    // names the phase itself — it is a wrapper that forwards whatever the owner it acquired says —
    // so it is checked for forwarding instead of for the literal.
    for (const owner of OWNERS.filter((name) => name !== "deferred-instance.ts")) {
      expect(source(owner), `${owner} can no longer report "running" at all`).toContain('"running"')
    }
    const deferred = source("deferred-instance.ts")
    expect(deferred, "the wrapper must still forward the phase its owner reports").toContain("owner?.state()")
  })
})
