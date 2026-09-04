import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Presence } from "@novaclaw/core/presence"
import { stripComments } from "./lib/source-scan"

/**
 * ─── the ratchet under `Presence`: an `existsSync` may never become an accusation ────────────────
 *
 * 🔴 **The defect class.** *An outcome that makes a claim about the SUBJECT when the evidence only
 * supports a claim about the INSTRUMENT.* `fs.existsSync` is the single richest source of it in this
 * tree, because it answers `false` for `EACCES`, `EPERM`, `ELOOP` and `EIO` **exactly as it does for
 * `ENOENT`** — so "I could not look" and "it is not there" arrive as one value, and the sentence built
 * from that value asserts the second while the evidence may only support the first.
 *
 * Audited 2026-08-19. Six independent sites had grown a user-facing accusation on top of that one
 * value; three of them carry a careful comment about ruling 2 in the same file. That is the argument
 * for a ledger rather than a convention: **the authors knew the rule, wrote it down, and reached for
 * `existsSync` anyway.**
 *
 * ⚠️ **Why a SOURCE sweep and not only a behavioural test** (the same reasoning
 * `offline-raw-transport-guards.test.ts` gives). The defect is not that a function returns the wrong
 * value — `existsSync` is behaving exactly as documented. The defect is WHICH FUNCTION was reached
 * for, and that is a source fact. A behavioural test would have to arrange an `EACCES` on every one of
 * these paths, on three platforms, to notice; this notices at author time.
 *
 * ── HOW IT FAILS ────────────────────────────────────────────────────────────────────────────────
 *
 * The ledger fails in BOTH directions:
 *   · a NEW production file calling `existsSync` fails until it is classified here;
 *   · an entry whose file no longer calls it fails with "drop the line", so the ledger cannot rot;
 *   · and `open` — the known-defect class — may only ever SHRINK.
 *
 * `open` is why there are three classes and not two. A ledger that only said "allowed" would have let
 * the site this round did not fix pass silently forever; one that demanded it be fixed today would have
 * been deleted by the next person in a hurry. A pinned, dated, counted admission is the honest middle,
 * and it is the shape of the expected-failure ledgers this repo already runs.
 *
 * ⭐ The second direction fired on its first run, which is the useful proof that none of this is
 * decorative: `session-worker/supervisor.ts` and `session-worker/scratch-folder.ts` were fixed in this
 * same round and stopped calling `existsSync` **at all**, so the ledger demanded they be dropped rather
 * than relabelled. That is the shape a real fix should have — the hazard leaves the file, not just the
 * verdict — and it is why the `presence` class below has one member and not three.
 */

const REPO = path.resolve(import.meta.dir, "..", "..", "..")
const PACKAGES = path.join(REPO, "packages")

/** `//` must not eat the `//` in a URL — the idiom the other source sweeps in this repo use. */

/**
 * What the site DOES with the answer. The classes are about the sentence, not about the call.
 *
 * - `fallback` — the answer only ever chooses between candidates, or gates an idempotent write. No
 *   claim about the user's machine is built from it, so a wrong `false` costs a retry, never a lie.
 * - `presence` — a claim IS built from it, and the file has been moved onto {@link Presence} so the
 *   claim can only be made on a confirmed `absent`.
 * - `open` — a claim is built from it and it is NOT yet fixed. Reported, dated, and pinned so the
 *   count can only go down.
 */
type Class = "fallback" | "presence" | "open"

interface Entry {
  readonly file: string
  readonly why: string
  readonly kind: Class
}

/**
 * Every production (non-test) file under `packages/<pkg>/src` that calls `existsSync`.
 *
 * ⚠️ Ordered by package then path so a diff on this list reads as one line added, not as a reshuffle.
 */
const LEDGER: readonly Entry[] = [
  // ── core ──────────────────────────────────────────────────────────────────────────────────────
  {
    file: "core/src/community/dht.ts",
    kind: "fallback",
    why: "picks the first of several candidate sidecar paths; a miss falls through to the next candidate.",
  },
  {
    file: "core/src/instance-registry.ts",
    kind: "fallback",
    why: "`existsSafely` decides whether a home is OFFERABLE in a picker; an unreadable home is correctly not offered.",
  },
  {
    file: "core/src/kb-graph/snapshot.ts",
    kind: "fallback",
    why: "asks whether the generation `CURRENT` names is present; a wrong `false` falls back to the next candidate, and no sentence about the user's machine is built from it.",
  },
  {
    file: "core/src/kb-graph/wasm-engine.ts",
    kind: "fallback",
    why: "a write-then-look drive-reach sentinel and two shape checks on a directory this process owns.",
  },
  {
    file: "core/src/observability/log-file.ts",
    kind: "fallback",
    why: "picks an unused segment file name; a wrong `false` costs a collision the caller already handles.",
  },
  {
    file: "core/src/observability/log-read.ts",
    kind: "fallback",
    why: "includes the active segment in a list when it is there; an omission is a shorter list, not a verdict.",
  },
  // `core/src/scratch.ts` was here, for the README it wrote when one was not already there. Both
  // scratch READMEs were deleted 2026-08-27 — an agent's working directory is handed to the model as
  // a grounding listing, so a seeded file cost every colleague a read on every fresh context — and the
  // file stopped calling `existsSync` with them. The ledger fails in both directions, so this line had
  // to go with the call rather than linger as a claim about code that no longer exists.
  {
    file: "core/src/session/runner/strict.ts",
    kind: "presence",
    why:
      "🔴 FIXED 2026-08-19. `fileExists` fed jh's verifier, which turned a `false` into the model- and " +
      "user-facing verdict “file not found: <path>” — a failed verification built on a permission refusal.",
  },
  {
    file: "core/src/util/kill-tree.ts",
    kind: "fallback",
    why: "detects `/proc` to choose a process-walk strategy; a miss selects the other strategy.",
  },
  {
    file: "core/src/virtual-fs.ts",
    kind: "fallback",
    why: "writes a README when it is not already there — idempotent, and no sentence is built from the answer.",
  },
  // ── desktop ───────────────────────────────────────────────────────────────────────────────────
  {
    file: "desktop/src/main/wsl/runtime.ts",
    kind: "fallback",
    why: "resolves a command to an absolute path, falling back to the bare command name.",
  },
  // ── host ──────────────────────────────────────────────────────────────────────────────────────
  {
    file: "host/src/host.node.ts",
    kind: "fallback",
    why:
      "classifies a `rename` watch event as create-or-delete. Documented in-file as an inherent race; the " +
      "consumer is a change feed that re-reads, not a claim.",
  },
  // ── http-recorder ─────────────────────────────────────────────────────────────────────────────
  {
    file: "http-recorder/src/cassette.ts",
    kind: "fallback",
    why: "test-fixture infrastructure deciding whether a cassette has been recorded yet.",
  },
  // ── novaclaw ──────────────────────────────────────────────────────────────────────────────────
  {
    file: "novaclaw/src/config/config.ts",
    kind: "fallback",
    why: "skips the managed-config directory when it is not present; an unreadable one is correctly not merged.",
  },
  {
    file: "novaclaw/src/config/managed.ts",
    kind: "fallback",
    why: "skips a macOS plist that is not there while scanning candidates.",
  },
  {
    file: "novaclaw/src/server/routes/instance/httpapi/middleware/workspace-routing.ts",
    kind: "open",
    why:
      "🔴 OPEN, reported 2026-08-19. An unreadable directory answers `InvalidDirectory` → HTTP 400 " +
      "“Directory does not exist: <dir>”, which `app/src/utils/server-errors.ts` matches by literal " +
      "prefix to raise “Project folder is missing … Restore that folder”. Fixing it honestly needs a " +
      "fourth request-plan arm AND a matching client branch AND new copy in 18 i18n bundles, so it is " +
      "pinned rather than half-built.",
  },
  {
    file: "novaclaw/src/util/filesystem.ts",
    kind: "fallback",
    why:
      "`exists()` gates reads (`config/markdown.ts`, `format/formatter.ts`) and " +
      "`writeStream` gates a recursive mkdir. No caller builds a sentence from it.",
  },
]

/** Walk `packages/<pkg>/src` and return every production file whose CODE calls `existsSync`. */
const sweep = (): string[] => {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "gen") continue
        walk(full)
        continue
      }
      if (!/\.tsx?$/.test(entry.name)) continue
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue
      const relative = path.relative(PACKAGES, full).replaceAll("\\", "/")
      // This module's own doc quotes the pattern it replaces; sweeping it would be the "regex over
      // source counts PROSE" trap, and it is stripped of comments already — so exclude it by name.
      if (relative === "core/src/presence.ts") continue
      if (/\bexistsSync\s*\(/.test(stripComments(fs.readFileSync(full, "utf8")))) found.push(relative)
    }
  }
  for (const pkg of fs.readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    const src = path.join(PACKAGES, pkg.name, "src")
    if (fs.existsSync(src)) walk(src)
  }
  return found.sort()
}

describe("Presence — the errno decision, made once", () => {
  test("ENOENT and ENOTDIR are the ONLY codes that mean “there is nothing there”", () => {
    expect(Presence.fromErrno("ENOENT")).toBe("absent")
    expect(Presence.fromErrno("ENOTDIR")).toBe("absent")
    expect([...Presence.ABSENT_CODES].sort()).toEqual(["ENOENT", "ENOTDIR"])
  })

  test("⭐ every other errno — and an unknown one — is the INSTRUMENT failing", () => {
    // The exclusion-guard precedent: the default is the safe answer, so an errno nobody has classified
    // degrades to "I could not look" rather than to "your file is gone".
    for (const code of ["EACCES", "EPERM", "ELOOP", "EIO", "EBUSY", "ENAMETOOLONG", "EWHATEVER", undefined])
      expect({ code, answer: Presence.fromErrno(code) }).toEqual({ code, answer: "unreadable" })
  })

  test("⭐ `isConfirmedAbsent` is not the negation of `isPresent` — that gap is the whole design", () => {
    // A path we cannot read is neither present nor absent, so a caller cannot reach an accusation by
    // inverting the happy case. This is the ergonomic difference from `!existsSync(p)`.
    const locked = path.join(import.meta.dir, "..", "..", "..")
    expect(Presence.isPresent(locked)).toBe(true)
    const gone = path.join(locked, "no-such-entry-9f3a2b")
    expect(Presence.isPresent(gone)).toBe(false)
    expect(Presence.isConfirmedAbsent(gone)).toBe(true)
    // A path UNDER a file: `ENOTDIR` on POSIX, `ENOENT` on win32. Both mean "nothing there", which is
    // why the absent set has two members — and why this asserts the ANSWER, not the errno.
    expect(Presence.probe(path.join(import.meta.path, "child"))).toBe("absent")
  })

  test("⭐ a real look that could not be PERFORMED answers `unreadable`, on a real filesystem", () => {
    // Not a stub. A NUL in a path is rejected by the syscall wrapper before any lookup happens, so the
    // filesystem never says anything about existence — exactly the state `EACCES` and a disconnected
    // share put us in, reproducible on every platform without needing to build one. `existsSync` gives
    // this the same `false` it gives a genuinely missing file; that collapse is the whole defect.
    const reading = Presence.read("C:/no\u0000such")
    expect(reading.answer).toBe("unreadable")
    expect(Presence.isConfirmedAbsent("C:/no\u0000such")).toBe(false)
    expect(Presence.isPresent("C:/no\u0000such")).toBe(false)
    expect(reading.code).toBeDefined()
  })

  test("the two vocabularies agree — an `unreadable` is what `faultEvidence` calls the instrument", () => {
    expect(Presence.evidenceOf("unreadable")).toBe("instrument")
    expect(Presence.evidenceOf("absent")).toBe("subject")
    expect(Presence.evidenceOf("present")).toBe("subject")
  })

  test("`couldNotRead` names the errno and asserts nothing about existence", () => {
    const sentence = Presence.couldNotRead("C:/work/report.md", { answer: "unreadable", code: "EACCES" })
    expect(sentence).toContain("EACCES")
    expect(sentence).toContain("I cannot tell whether it is still there")
    for (const forbidden of ["no longer exists", "is missing", "not found", "does not exist"])
      expect(sentence).not.toContain(forbidden)
  })
})

describe("the ledger — a new presence oracle cannot ship unclassified", () => {
  const swept = sweep()

  test("the sweep found files at all (a silently-empty sweep would pass every assertion below)", () => {
    expect(swept.length).toBeGreaterThan(10)
  })

  test("⭐ every production `existsSync` call site is classified here, and every entry still calls it", () => {
    expect(swept).toEqual([...LEDGER].map((entry) => entry.file).sort())
  })

  test("⭐ every `presence` entry actually reaches `Presence` — the class is not just a label", () => {
    for (const entry of LEDGER.filter((row) => row.kind === "presence")) {
      const code = stripComments(fs.readFileSync(path.join(PACKAGES, entry.file), "utf8"))
      expect({ file: entry.file, usesPresence: /\bPresence\./.test(code) }).toEqual({
        file: entry.file,
        usesPresence: true,
      })
    }
  })

  test("⭐ the known-defect class may only SHRINK", () => {
    // 2026-08-19: two sites were found building a user-facing accusation on a bare `existsSync`; one
    // was fixed in the same round, one needs an i18n change across 18 bundles and is pinned here.
    // Raising this number is how a regression ships, so it is an assertion and not a comment.
    expect(LEDGER.filter((entry) => entry.kind === "open").length).toBeLessThanOrEqual(1)
  })

  test("every entry carries a REASON — a ledger of bare paths teaches nobody anything", () => {
    for (const entry of LEDGER)
      expect({ file: entry.file, ok: entry.why.length > 40 }).toEqual({ file: entry.file, ok: true })
  })
})
