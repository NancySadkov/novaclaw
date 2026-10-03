import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { stripComments } from "./lib/source-scan"

/**
 * 🔴 ONE SEAM ADMITS HARNESS INTERJECTIONS. A CHAT LLM IS NEVER STEERED.
 *
 * **What this closes, measured 2026-09-29.** Xenia — the shipped Companion, a *chat* LLM with every
 * tool withdrawn and therefore no `exit` — ran 61 generations with no user message before any of them.
 * Her session's last input was a harness steer: `"Recover and proceed."`, admitted
 * and promoted (`admitted_seq=99`, `promoted_seq=100`). Once started she cannot stop: chat mode
 * withdraws every tool, so nothing in her turn can end it.
 *
 * **Why a ratchet and not a review.** The primitive had 19 production call sites and the rule lived
 * one delegation away, in a function most callers reached only by accident. Policy beside the
 * primitive is policy every future caller must remember. The gate now lives INSIDE
 * `session/steering.ts`, and these cases hold that: a bypass is a failing test, not a code-review miss.
 *
 * ⚠️ The scan strips comments before matching, via the shared AST strip. A ratchet that reads prose
 * reports the explanation of a guard as a violation of it — which is how this file's own first draft
 * would have failed.
 */
const ROOT = join(import.meta.dir, "..", "..", "..")
const STEERING = "packages/core/src/session/steering.ts"
const SKIP = new Set([
  "node_modules",
  "dist",
  "out",
  "build",
  "coverage",
  "gen",
  ".git",
  ".ts-dist",
  ".turbo",
  ".vite",
  "playwright-report",
  "test-results",
])

/**
 * Call sites still on the primitive, each with the reason it could not move.
 *
 * ⚠️ This list is DEBT, not permission. It fails in both directions: a new bypass fails outright, and
 * a listed entry that stops calling the primitive fails with "remove the entry", so a fix forces the
 * debt out and the list can only shrink toward empty.
 */
const KNOWN_BYPASSES: [path: string, reason: string][] = [
  [
    "packages/novaclaw/src/session-worker/execution.ts",
    "the worker `message` callback is typed Effect<boolean, never, never> — it forbids an error channel, and the seam's mode lookup introduces one. Migrating it needs a total seam or a widened callback; neither is decided, so it is recorded rather than papered over with a silent catch.",
  ],
  [
    "packages/core/src/work-project/store.ts",
    "an `automated` admit with a caller-minted idempotency id. The seam accepts a caller id, so this is a mechanical fold that has not been made yet.",
  ],
]

const sourceFiles = (): string[] => {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(full)
    }
  }
  for (const pkg of ["core", "novaclaw", "app", "desktop", "server", "script"]) {
    const src = join(ROOT, "packages", pkg, "src")
    try {
      walk(src)
    } catch {
      /* a package without src is not a failure */
    }
  }
  return found
}

/** Files that call the primitive, as repo-relative paths. */
const callers = (): string[] =>
  sourceFiles()
    .map((path) => ({
      path: relative(ROOT, path).replaceAll("\\", "/"),
      parsed: stripComments(readFileSync(path, "utf8"), path),
    }))
    .filter((entry) => /SessionInput\.(?:steer|automated)\(/.test(entry.parsed))
    .map((entry) => entry.path)
    .sort()

describe("the steering seam is the only way to admit a harness interjection", () => {
  const actual = callers()

  test("no unlisted file calls the primitive directly", () => {
    const known = KNOWN_BYPASSES.map(([path]) => path)
    const unlisted = actual.filter((path) => !known.includes(path))
    expect(
      unlisted,
      unlisted.length
        ? "These admit a harness interjection WITHOUT the mode gate in session/steering.ts, so they can\n" +
            "  wake a chat LLM — which has no exit tool and therefore cannot stop.\n" +
            "  Fix: import { Steering } and call Steering.inject(db, events, { sessionID, reason, text }).\n" +
            `  Offenders:\n${unlisted.map((p) => `    ${p}`).join("\n")}`
        : "",
    ).toEqual([])
  })

  test("the seam itself is not a bypass", () => {
    // The gate lives here, so this module is the one place allowed to reach the primitive. If a
    // future edit routes around its own gate, the module stops being the seam and says so.
    expect(actual, "the seam module must not appear as a bypass").not.toContain(STEERING)
  })

  test("🔴 the bypass ledger only shrinks — a migrated site must leave the list", () => {
    const settled = KNOWN_BYPASSES.filter(([path]) => !actual.includes(path)).map(([path]) => path)
    expect(
      settled,
      settled.length
        ? `These no longer call the primitive, so the ledger entry is stale — remove it:\n${settled
            .map((p) => `    ${p}`)
            .join("\n")}`
        : "",
    ).toEqual([])
  })

  test("every bypass has a stated reason, because an unexplained entry is an exemption", () => {
    for (const [path, reason] of KNOWN_BYPASSES) {
      expect(reason.length, `${path} must say why it is still on the old path`).toBeGreaterThan(40)
    }
  })

  test("the detector still finds the seam's own callers — a guard that finds nothing is off", () => {
    // A count-based ratchet fails silently: break the scan and "no unlisted bypass" passes for the
    // wrong reason. Pin the population so a dead scan fails HERE.
    expect(actual.length, "the scan found no primitive callers at all — it is broken").toBeGreaterThan(0)
    expect(actual.length, "ledger and scan disagree on the population").toBe(KNOWN_BYPASSES.length)
  })
})

describe("the interjection vocabulary is closed", () => {
  const steering = stripComments(readFileSync(join(ROOT, STEERING), "utf8"), STEERING)

  test("a reason is a member of one union, not a free string", () => {
    // The value of naming a reason is that the set can be audited. A `reason: string` would compile
    // green with any text in it and the audit would be gone.
    expect(steering).toMatch(/export type Interjection =\n/)
    expect(steering).toMatch(/\| "restart"/)
  })

  test("every call site passes a reason from that union", () => {
    // ⚠️ Slice the union itself. The first draft matched `| "…"` anywhere in the file and collected
    // every object literal in the module — 76 phantom members, including `hook` and `crash`. A scan
    // that reads more than its subject is a scan that cannot fail for the right reason.
    const start = steering.indexOf("export type Interjection =")
    expect(start, "the union must be declared in the seam module").toBeGreaterThan(-1)
    const end = steering.indexOf(";", start)
    const union = steering.slice(start, end)
    const members = new Set([...union.matchAll(/\| "([a-z-]+)"/g)].map((match) => match[1]!))
    expect(members.size, "the union must not be empty — a scan that reads nothing proves nothing").toBeGreaterThan(5)

    // Only the reason INSIDE a `Steering.inject(` call. The first draft matched any `reason: "…"` in
    // a file that happened to call the seam, and collected four phantoms from unrelated domain
    // objects (`auto`, `new-input`). The subject is the call, not the file.
    const used = new Set<string>()
    for (const path of sourceFiles()) {
      const raw = readFileSync(path, "utf8")
      if (!raw.includes("Steering.inject")) continue
      const parsed = stripComments(raw, path)
      for (const call of parsed.matchAll(/Steering\.inject\([\s\S]{0,400}?\}\)/g)) {
        for (const match of call[0].matchAll(/reason: "([a-z-]+)"/g)) used.add(match[1]!)
      }
    }
    expect(used.size, "no call site names a reason — the migration did not happen").toBeGreaterThan(5)
    const unknown = [...used].filter((reason) => !members.has(reason))
    expect(
      unknown,
      unknown.length
        ? `These reasons are not in the Interjection union, so the audit cannot see them:\n${unknown
            .map((r) => `    ${r}`)
            .join("\n")}`
        : "",
    ).toEqual([])
  })

  test("the gate is INSIDE the module, not beside it", () => {
    // The whole defect was policy adjacent to the primitive. Pin that the mode check lives in the
    // same function that admits, so it cannot be stepped over by a caller that never looks for it.
    expect(steering).toMatch(/resolveSessionMode\(db, injection\.sessionID\)/)
    expect(steering).toMatch(/if \(mode !== "agent"\)/)
  })

  test("a refusal is loud — a silently dropped interjection is a mystery", () => {
    const events = stripComments(
      readFileSync(join(ROOT, "packages/schema/src/log-events.ts"), "utf8"),
      "log-events.ts",
    )
    const block = /"session\.steering\.refused":\s*\{[\s\S]*?level: "(\w+)"[\s\S]*?content: "(\w+)"/.exec(events)
    expect(block?.[1], "a refused interjection must declare a level").toBe("warn")
    // "none", deliberately: this event carries a session id, and the house rule is that such an event
    // may not egress. `warn` is what makes it findable; claiming "user" would have been a promise the
    // redaction model forbids, and the log-events guard fails the build on exactly that.
    expect(block?.[2], "an event carrying a session id is `correlated`, which is what the guard derives").toBe("correlated")
  })
})
