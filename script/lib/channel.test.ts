import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"

import { CHANNELS, resolveChannel } from "./channel"

/**
 * The channel decides the app id, the instance data directory and the DATABASE FILENAME (it becomes
 * the `NOVACLAW_CHANNEL` build define, i.e. `InstallationChannel`). Until 2026-07-27 four call sites
 * resolved it independently and disagreed:
 *
 *   · `packages/script/src/index.ts` fell back to `git branch --show-current` — which THROWS in the
 *     published source zip and otherwise baked a branch name into shipped binaries, so two branches
 *     silently meant two databases.
 *   · `electron.vite.config.ts` understood the "latest" alias; `electron-builder.config.ts` did not.
 *     So `NOVACLAW_CHANNEL=latest` produced one binary whose app id said `.dev` and whose compiled-in
 *     channel said `prod` — the two halves of a single build disagreeing about where it lives.
 *
 * Both are invariants whose violation compiled green, so per todo.md ruling 1 they ship with the
 * check that enforces them. `semantics` pins WHAT the resolver answers; `one resolver` is a ratchet
 * that fails if a call site grows its own copy again.
 */

const REPO = path.resolve(import.meta.dir, "../..")
const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf8")

/**
 * The TypeScript files that mention NOVACLAW_CHANNEL at all, via ONE `git grep`.
 *
 * ⚠️ This was originally `git ls-files` + reading every file in Node. That passed in 0.3 s against a
 * warm page cache and took **64 s** — blowing the 15 s per-test timeout — inside a full suite run,
 * where the cache is cold and thousands of reads are competing. `git grep` does the search in one
 * process and returns only the handful of matches, so the cost is O(matches), not O(repo). A glob is
 * worse still: it walks `node_modules`. git also excludes the trees we do not own for free, and
 * `--untracked` is what makes a brand-new, not-yet-committed offender visible.
 */
let cachedMentions: string[] | undefined
function filesMentioningChannel(): string[] {
  if (cachedMentions) return cachedMentions
  const proc = spawnSync("git", ["grep", "--untracked", "-l", "-F", "NOVACLAW_CHANNEL", "--", "*.ts", "*.tsx"], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
  // git grep exits 1 when there are no matches, which for this repo would itself be suspicious — the
  // vacuity test below is what turns that into a failure rather than a silent pass.
  if (proc.status !== 0 && proc.status !== 1)
    throw new Error(`git grep failed (${proc.status}): ${proc.stderr || proc.error?.message}`)
  cachedMentions = proc.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes("/dist/") && !line.includes("/gen/"))
  return cachedMentions
}

describe("resolveChannel — semantics", () => {
  test("unset and empty mean dev; nothing else is consulted", () => {
    // Passed explicitly rather than via process.env so the case cannot be perturbed by the ambient
    // environment of whoever runs the suite.
    expect([resolveChannel(undefined), resolveChannel("")]).toEqual(["dev", "dev"])
  })

  test("every channel resolves to itself", () => {
    expect(CHANNELS.map((channel) => resolveChannel(channel))).toEqual([...CHANNELS])
  })

  test('"latest" is the prod alias — the divergence that shipped', () => {
    expect(resolveChannel("latest")).toBe("prod")
  })

  test("an unrecognised value THROWS rather than silently becoming dev", () => {
    // The old resolvers fell back to "dev" (three of them) or passed the raw string into the define
    // (the fourth), so a typo produced either a mislabelled artifact or a wrong DB filename, silently.
    // AGENTS.md → Known pitfalls #0 is this project shipping the literal string "undefined" as an env
    // value: a fallback swallows exactly that, a throw names it.
    for (const bad of ["prd", "Dev", "main", "undefined", "true"])
      expect(() => resolveChannel(bad)).toThrow(/is not a channel/)
  })

  test("the env var is read at CALL time, never frozen at import", () => {
    // Known pitfalls #0(a): a path resolved at module import can be answered before the process can
    // answer it, and a wrong value then becomes permanent.
    const saved = process.env["NOVACLAW_CHANNEL"]
    try {
      process.env["NOVACLAW_CHANNEL"] = "beta"
      expect(resolveChannel()).toBe("beta")
      process.env["NOVACLAW_CHANNEL"] = "latest"
      expect(resolveChannel()).toBe("prod")
      delete process.env["NOVACLAW_CHANNEL"]
      expect(resolveChannel()).toBe("dev")
    } finally {
      if (saved === undefined) delete process.env["NOVACLAW_CHANNEL"]
      else process.env["NOVACLAW_CHANNEL"] = saved
    }
  })
})

describe("one resolver — the ratchet", () => {
  /**
   * Files that legitimately name NOVACLAW_CHANNEL for a reason OTHER than resolving it: they declare
   * its type, consume the compiled-in define, or write the define. Everything else must obtain the
   * channel from `script/lib/channel.ts`.
   */
  const DEFINE_SIDE = [
    "packages/app/src/env.d.ts", // type declaration only
    "packages/desktop/src/main/env.d.ts", // type declaration only
    "packages/core/src/installation/version.ts", // reads the DEFINE at runtime — the honest consumer
    "packages/desktop/src/main/constants.ts", // reads the define in the Electron main
    "packages/novaclaw/script/build-node.ts", // WRITES the define, from Script.channel
    "packages/novaclaw/script/build.ts", // WRITES the define, from Script.channel
    "packages/desktop/electron-builder.config.test.ts", // sets the env var as a test fixture
  ]

  /** The build-tooling files that must resolve the channel, and must do it through the one module. */
  const RESOLVER_CONSUMERS = [
    "packages/script/src/index.ts",
    "packages/desktop/scripts/utils.ts",
    "packages/desktop/scripts/predev.ts",
    "packages/desktop/electron-builder.config.ts",
    "packages/desktop/electron.vite.config.ts",
  ]

  test("every consumer imports the shared resolver", () => {
    // Either straight from `script/lib/channel`, or via `./utils`, which re-exports it for the
    // desktop build scripts that already imported from there.
    const importsResolver = (source: string) =>
      /from "[^"]*lib\/channel"/.test(source) || /from "\.\/utils"/.test(source)
    expect(RESOLVER_CONSUMERS.filter((rel) => !importsResolver(read(rel)))).toEqual([])
  })

  test("no consumer re-implements the channel decision", () => {
    // The shape every old copy had: a chain of equality tests against the channel literals. Matching
    // on that shape (rather than on the env var) is what makes this a ratchet — a NEW hand-rolled
    // resolver fails here even if it reads the value some other way.
    const reimplemented = RESOLVER_CONSUMERS.filter(
      (rel) => /===\s*"dev"\s*\|\|/.test(read(rel)) || /raw\s*===\s*"latest"/.test(read(rel)),
    )
    expect(reimplemented).toEqual([])
  })

  test("nothing outside the allowlist reads process.env.NOVACLAW_CHANNEL", () => {
    const allowed = new Set([
      ...DEFINE_SIDE,
      ...RESOLVER_CONSUMERS,
      "script/lib/channel.ts",
      "script/lib/channel.test.ts",
    ])
    const offenders = filesMentioningChannel().filter(
      (rel) => !allowed.has(rel) && /(process|Bun)\.env\[?["'.]?NOVACLAW_CHANNEL/.test(read(rel)),
    )
    expect(offenders).toEqual([])
  })

  test("the sweep is not vacuous", () => {
    // Three ways this suite could pass while checking nothing: the grep finds nothing (a broken
    // pattern, or being run outside the repo), the allowlist covers everything, or the resolver
    // stopped reading the variable it is supposed to own.
    const mentions = filesMentioningChannel()
    expect(mentions.length).toBeGreaterThan(5)
    expect(mentions).toContain("packages/core/src/installation/version.ts")
    expect(mentions).toContain("script/lib/channel.ts")
    expect(/process\.env\["NOVACLAW_CHANNEL"\]/.test(read("script/lib/channel.ts"))).toBe(true)
    expect(RESOLVER_CONSUMERS.length).toBeGreaterThan(3)
  })
})
