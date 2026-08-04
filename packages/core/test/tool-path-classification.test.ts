import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

// The sweep, as a standing guard rather than a one-off audit.
//
// Every tool that turns CALLER-SUPPLIED input into a filesystem path must contain it through
// `LocationMutation.resolve`, which canonicalizes via realPath and so catches both `../..` escapes and
// symlinks pointing out of the workspace. Two rounds of this have already been got wrong:
//   · glob/grep resolved `input.path` with no containment at all (an absolute path was searched silently,
//     and grep returns matching LINES, i.e. content);
//   · messenger contained upload/download LEXICALLY (`path.resolve` + `FSUtil.contains`), which does not
//     resolve symlinks, so a link inside the workspace read/wrote outside it.
// Both looked fine by inspection. A grep is the only thing that reliably notices the next one.
//
// ⚠️ The sweep used to read `src/tool/*.ts` NON-RECURSIVELY, so the two other surfaces that execute
// on the host — the jh/Strict engine (`src/jh/**`) and the session runner (`src/session/runner/**`) —
// were invisible to it. That is exactly where the Agent Jail was NOT consulted: Strict spawned raw
// `node:child_process` children with `{ ...process.env }`. The roots below are the containment
// surface, and the guard now covers all of it.

const SRC = path.join(import.meta.dir, "..", "src")
const ROOTS = ["tool", "jh", path.join("session", "runner")]

interface Source {
  /** src-relative, posix-separated — the name the ledgers and failures speak. */
  readonly name: string
  /** CODE ONLY — comments are stripped, so a guard answers "does this file DO it", never "does it
   *  mention it". Half the files here explain the containment rules in prose. */
  readonly text: string
}

/** Comment stripper (the shape `src/jh/imports.test.ts` uses — `//` must not eat a `://` in a URL). */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")

function collect(dir: string): Source[] {
  const out: Source[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collect(full))
      continue
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue
    out.push({
      name: path.relative(SRC, full).replaceAll("\\", "/"),
      text: stripComments(fs.readFileSync(full, "utf8")),
    })
  }
  return out
}

const sources = ROOTS.flatMap((root) => collect(path.join(SRC, root)))

/** `path.resolve(location.directory, …input…)` — turning model input into a real path. */
const RESOLVES_INPUT = /path\.resolve\(\s*location\.directory\s*,\s*[^)]*\binput\b/

/** The lexical containment that superseded nothing — it cannot see through a symlink. */
const LEXICAL_CONTAINMENT = /FSUtil\.contains\(\s*location\.directory/

/** A file that starts a HOST process: it imports a spawner, or builds an Effect ChildProcess. */
const STARTS_HOST_PROCESS = /from\s+["'](?:node:child_process|cross-spawn)["']|ChildProcess\.make\(/

/** …and therefore must consume the ONE host-execution gate (v0.2.0 ruling 6, `src/host-exec.ts`),
 *  which owns containment, the jail decision, shell resolution and environment composition. */
const GATED = /HostExec\./

/**
 * The ungated call sites that remain, each with the reason it is still outstanding. This ledger can
 * only SHRINK: an entry whose file no longer spawns — or has since been gated — fails the staleness
 * check below, so a fix forces the entry out. Adding a NEW ungated spawner fails outright.
 *
 * ⚠️ `residue` exists because a file can hold BOTH a gated call site and an ungated one. Since
 * `session/runner/llm.ts` started passing `HostExec.SessionHost` into the Strict runner, the
 * whole-file `GATED` test says "gated" while `runQualityCheck` still spawns with its own shell and
 * the inherited environment. Dropping the entry would have been a LIE, and keeping a plain entry
 * would have made the staleness check fire forever. So a residued entry stays ledgered while the
 * NAMED ungated spawn is still in the file, and is forced out the moment that exact spawn goes.
 */
interface Ungated {
  readonly reason: string
  /** The specific ungated spawn, for a file that ALSO consumes the gate elsewhere. */
  readonly residue?: RegExp
}

const UNGATED_LEDGER = new Map<string, Ungated>([
  [
    "jh/process-runner.ts",
    {
      reason:
        "the executor itself. §0.7.2 (jh/imports.test.ts) forbids src/jh/** from importing the gate, so " +
        "it executes a SpawnPlan handed to it by session/runner/strict.ts and decides nothing.",
    },
  ],
  [
    "tool/js-run.ts",
    {
      reason:
        "the js sandbox child. Its ENV is composed by tool/js.ts through the gate; the runtime binary is " +
        "resolved by a probe here (execPath vs bun vs node), so the exec cannot be planned upstream yet.",
    },
  ],
  [
    "tool/quality-provision.ts",
    {
      reason:
        "runs the permission-approved quality candidates with its own Shell.agentDefault() and the " +
        "inherited environment — a third host-exec call site still to re-point.",
    },
  ],
  [
    "session/runner/llm.ts",
    {
      reason:
        "runQualityCheck spawns the configured quality commands with its own shell resolution and the " +
        "inherited environment — same re-point as tool/quality-provision.ts. The Strict drain in the " +
        "same file DOES go through the gate, hence the residue.",
      residue: /ChildProcess\.make\(check\.command/,
    },
  ],
])

describe("tool path classification", () => {
  test("the sweep actually has files to look at", () => {
    expect(sources.length).toBeGreaterThan(10)
  })

  test("the sweep recurses into every host-execution surface, not just src/tool", () => {
    // The three roots each have to be really present — a mistyped root would silently empty the sweep.
    for (const name of ["tool/bash.ts", "jh/process-runner.ts", "session/runner/strict.ts"])
      expect(sources.map((file) => file.name)).toContain(name)
  })

  test("a tool that resolves caller input against the location must classify it", () => {
    const offenders = sources
      .filter((file) => RESOLVES_INPUT.test(file.text))
      .filter((file) => !file.text.includes("mutation.resolve"))
      .map((file) => file.name)
    expect(offenders).toEqual([])
  })

  test("no tool contains a path lexically instead of canonically", () => {
    // `FSUtil.contains(location.directory, …)` cannot see through a symlink. Containment belongs to
    // LocationMutation; this pattern is how the messenger hole survived review.
    const offenders = sources.filter((file) => LEXICAL_CONTAINMENT.test(file.text)).map((file) => file.name)
    expect(offenders).toEqual([])
  })

  test("the file tools all still route through LocationMutation (the guard can actually fail)", () => {
    // A negative control for the guard itself: if these stopped classifying, the checks above must notice.
    for (const name of [
      "tool/read.ts",
      "tool/write.ts",
      "tool/edit.ts",
      "tool/apply-patch.ts",
      "tool/trash.ts",
      "tool/glob.ts",
      "tool/grep.ts",
    ]) {
      const file = sources.find((item) => item.name === name)
      expect(file, `${name} missing from the sweep`).toBeDefined()
      expect(file!.text, `${name} no longer classifies its paths`).toContain("mutation.resolve")
    }
  })
})

describe("host execution goes through ONE gate", () => {
  test("no new ungated host spawner appears on the containment surface", () => {
    const offenders = sources
      .filter((file) => STARTS_HOST_PROCESS.test(file.text))
      .filter((file) => !GATED.test(file.text))
      .filter((file) => !UNGATED_LEDGER.has(file.name))
      .map((file) => file.name)
    expect(offenders).toEqual([])
  })

  test("the ledger can only shrink — a fixed or vanished entry must be deleted from it", () => {
    const stale: string[] = []
    for (const [name, entry] of UNGATED_LEDGER) {
      const file = sources.find((item) => item.name === name)
      if (file === undefined) {
        stale.push(`${name} (no longer exists)`)
        continue
      }
      if (!STARTS_HOST_PROCESS.test(file.text)) {
        stale.push(`${name} (no longer starts a host process)`)
        continue
      }
      // A residued entry is pinned to its NAMED ungated spawn, not to the whole file: the file may
      // legitimately consume the gate elsewhere. It leaves the ledger when that spawn is re-pointed.
      if (entry.residue !== undefined) {
        if (!entry.residue.test(file.text))
          stale.push(`${name} (the ledgered ungated spawn is gone — drop the ledger entry)`)
        continue
      }
      if (GATED.test(file.text)) stale.push(`${name} (now consumes HostExec — drop the ledger entry)`)
    }
    expect(stale).toEqual([])
  })

  test("a residued entry is really a MIXED file — gated Strict, ungated quality check", () => {
    // The negative control for the residue mechanism itself: without both halves being true of the
    // real file, the relaxed staleness rule above would be hiding an ungated spawner rather than
    // describing one. `session/runner/llm.ts` must show BOTH.
    const file = sources.find((item) => item.name === "session/runner/llm.ts")
    expect(file, "session/runner/llm.ts missing from the sweep").toBeDefined()
    expect(file!.text, "the Strict drain no longer passes the host-exec context").toMatch(
      /HostExec\.chainHasHostileBinding/,
    )
    expect(file!.text, "runQualityCheck no longer spawns ungated — drop the ledger entry").toMatch(
      UNGATED_LEDGER.get("session/runner/llm.ts")!.residue!,
    )
  })

  test("tool/bash.ts and the Strict runner both consume the gate", () => {
    for (const name of ["tool/bash.ts", "tool/js.ts", "session/runner/strict.ts"]) {
      const file = sources.find((item) => item.name === name)
      expect(file, `${name} missing from the sweep`).toBeDefined()
      expect(file!.text, `${name} no longer goes through host-exec.ts`).toMatch(GATED)
    }
  })

  test("the session path never builds an UNGATED jh runner", () => {
    // `JhProcessRunner.shellRunner` is the ungated plain-shell escape hatch (engine unit tests). A
    // session-side caller using it is precisely the second call site ruling 6 exists to prevent — it
    // is how Strict came to run with `{ ...process.env }` and no jail decision.
    const offenders = sources
      .filter((file) => file.name.startsWith("session/") && /JhProcessRunner\.shellRunner\(/.test(file.text))
      .map((file) => file.name)
    expect(offenders).toEqual([])
  })

  test("the gate guards actually bite (negative control)", () => {
    const bareSpawn = `import { spawn } from "node:child_process"\nspawn(cmd, [], { env: { ...process.env } })`
    const effectSpawn = `const c = ChildProcess.make(command, [], { shell })`
    const gated = `import { HostExec } from "../host-exec"\nconst p = HostExec.plan(request)`
    // a file that spawns and does not mention the gate is caught…
    expect(STARTS_HOST_PROCESS.test(bareSpawn) && !GATED.test(bareSpawn)).toBe(true)
    expect(STARTS_HOST_PROCESS.test(effectSpawn) && !GATED.test(effectSpawn)).toBe(true)
    // …and one that routes through it is not.
    expect(STARTS_HOST_PROCESS.test(`${bareSpawn}\n${gated}`) && !GATED.test(`${bareSpawn}\n${gated}`)).toBe(false)
    // the ungated-runner check is not vacuous either
    expect(/JhProcessRunner\.shellRunner\(/.test("const r = JhProcessRunner.shellRunner({ shell })")).toBe(true)
    // and the path-classification regexes still match the shapes they were written for
    expect(RESOLVES_INPUT.test("const p = path.resolve(location.directory, input.path)")).toBe(true)
    expect(LEXICAL_CONTAINMENT.test("if (!FSUtil.contains(location.directory, absolute)) fail()")).toBe(true)
  })
})
