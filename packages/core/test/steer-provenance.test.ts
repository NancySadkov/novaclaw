import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import { Message } from "@novaclaw/llm"
import {
  applySteerProvenance,
  firstRealUserText,
  isRealUserTurn,
  isSteerText,
  lastRealUserIndex,
  lastRealUserText,
  lastRealUserTurn,
  stripSteerProvenance,
  STEER_PROVENANCE_PREFIX,
} from "@novaclaw/core/session/steer-provenance"
import { SessionExtract } from "@novaclaw/core/session/runner/extract"
import { SessionRecall } from "@novaclaw/core/session/runner/recall"
import { SessionTitle } from "@novaclaw/core/session/title"
import { toolCallsSinceLastUser } from "@novaclaw/core/session/runner/doom-loop"
import { demoteSystemMessages, isRealUserMessage } from "@novaclaw/core/session/runner/context-pack"
import type { SessionMessage } from "@novaclaw/core/session/message"

// B2 — "is this really the user talking?" is asked in six places, and a wrong answer is invisible.
//
// A harness steer (doom-loop redirect, quality nudge, introspection prompt) is authored by the
// HARNESS but enters the transcript as a `type:"user"` message; the 1N provenance prefix is the only
// thing that distinguishes it. Six consumers read "the user's text" out of a transcript, and two of
// them never asked: auto-extraction fed the harness's own instruction text to the extractor, which
// wrote it into session memory as a fact about the USER — and `kb-graph`'s `consolidate()` promotes
// session-scoped auto-extracted memories to GLOBAL twins on a 5-minute timer, so the scaffolding
// became a durable, cross-session "fact". Auto-recall meanwhile searched memory with that same text
// as the query. Both compiled green and neither ever threw.
//
// This file is the mechanical half of the fix (standing decision 2 — an invariant whose violation
// compiles green ships with a check or it does not exist). It has two layers:
//   1. BEHAVIOUR — every transcript consumer, driven with a steer-laden transcript.
//   2. A SOURCE LEDGER — a scan of `src/session/**` that fails on a NEW unfiltered user-role read,
//      and equally on a ledger row that has become stale.
//
// The SEVENTH site was `compaction.ts`, ledgered as PENDING here and converted afterwards: it
// rendered a steer as `[User]: …` inside the durable summary. Its behaviour lives in
// `test/session-compaction.test.ts`; the stale-row test at the bottom is what forced the row out.

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────
// Minimal projected-history shapes; these helpers only read the fields modeled here.
const user = (text: string): SessionMessage.Message => ({ type: "user", text }) as unknown as SessionMessage.Message
const steer = (text: string): SessionMessage.Message => user(applySteerProvenance(text))
const assistant = (...texts: string[]): SessionMessage.Message =>
  ({ type: "assistant", content: texts.map((text) => ({ type: "text", text })) }) as unknown as SessionMessage.Message
const assistantCall = (name: string, input: Record<string, unknown>, failed: boolean): SessionMessage.Message =>
  ({
    type: "assistant",
    content: [{ type: "tool", name, state: { status: failed ? "error" : "completed", input } }],
  }) as unknown as SessionMessage.Message

/** The wording of a real steer, so a fixture can never drift from the thing being detected. */
const NUDGE = "You have called `bash` with identical arguments 3 times in a row. Stop repeating it."

// ── layer 1: the one predicate ──────────────────────────────────────────────────────────────────

describe("the steer predicate", () => {
  test("round-trips: apply → detect → strip, and plain user text is never mistaken for a steer", () => {
    const tagged = applySteerProvenance(NUDGE)
    expect(isSteerText(tagged)).toBe(true)
    expect(stripSteerProvenance(tagged)).toBe(NUDGE)
    expect(isSteerText(NUDGE)).toBe(false)
    expect(isSteerText("")).toBe(false)
  })

  test("isRealUserTurn: the user speaking, not a steer riding the user role, not another type", () => {
    expect(isRealUserTurn(user("fix the parser"))).toBe(true)
    expect(isRealUserTurn(steer(NUDGE))).toBe(false)
    expect(isRealUserTurn(assistant("on it"))).toBe(false)
  })
})

describe("the shared transcript walks", () => {
  const context = [user("first task"), assistant("ok"), steer(NUDGE), assistant("retrying"), user("  second task  ")]

  test("lastRealUserTurn locates the newest real turn, trimmed, with its index", () => {
    expect(lastRealUserTurn(context)).toEqual({ index: 4, text: "second task" })
    expect(firstRealUserText(context)).toBe("first task")
    expect(lastRealUserText(context)).toBe("second task")
  })

  test("a steer is skipped, never treated as the boundary of the walk", () => {
    expect(lastRealUserTurn([user("real"), assistant("x"), steer(NUDGE)])).toEqual({ index: 0, text: "real" })
    expect(lastRealUserText([steer(NUDGE)])).toBeUndefined()
    expect(firstRealUserText([steer(NUDGE)])).toBeUndefined()
    expect(lastRealUserIndex([steer(NUDGE)])).toBe(-1)
  })

  test("blank turns carry no text but still mark where the goal started", () => {
    // The text-bearing walks answer "what did the user say" — a blank turn cannot. The INDEX walk
    // answers "where did the current goal start", and a files-only prompt is still a new goal.
    const blanked = [user("old goal"), assistant("x"), user("   ")]
    expect(lastRealUserText(blanked)).toBe("old goal")
    expect(lastRealUserIndex(blanked)).toBe(2)
    expect(lastRealUserIndex([])).toBe(-1)
  })
})

// ── layer 1: every transcript consumer, driven with a steer ─────────────────────────────────────

/** The consumers that turn a transcript into user-authored TEXT. A steer must never reach any. */
const TEXT_CONSUMERS: ReadonlyArray<{
  readonly name: string
  readonly read: (context: readonly SessionMessage.Message[]) => string | undefined
}> = [
  { name: "SessionExtract.buildExchange (→ auto-extracted memory → global twin)", read: SessionExtract.buildExchange },
  { name: "SessionRecall.recallQuery (→ the memory retrieval query)", read: SessionRecall.recallQuery },
  { name: "SessionTitle.firstRealUserText (→ the session title)", read: SessionTitle.firstRealUserText },
]

describe("no transcript consumer ever reads the harness's own words as the user's", () => {
  for (const consumer of TEXT_CONSUMERS) {
    test(`${consumer.name}: a steer-only transcript yields nothing`, () => {
      expect(consumer.read([steer(NUDGE), assistant("retrying")])).toBeUndefined()
    })

    test(`${consumer.name}: the newest steer never displaces the real user text`, () => {
      const context = [user("count the digits of pi"), assistant("working"), steer(NUDGE), assistant("retrying")]
      const out = consumer.read(context)
      expect(out).toBeDefined()
      expect(out).not.toContain(STEER_PROVENANCE_PREFIX)
      expect(out).not.toContain("identical arguments")
      expect(out).toContain("count the digits of pi")
    })
  }
})

describe("auto-extraction (the durable-memory leg of B2)", () => {
  test("anchors on the real user turn and excludes every assistant-originated byte", () => {
    const exchange = SessionExtract.buildExchange([
      user("my name is Nadia"),
      assistant("Nice to meet you"),
      steer(NUDGE),
      assistant("Continuing."),
    ])
    // Both assistant replies may have been influenced by auto-recalled memory. Excluding them by
    // origin prevents a recalled fact from manufacturing a new durable candidate through paraphrase.
    expect(exchange).toBe("User: my name is Nadia")
  })

  test("the memory id of an extracted fact never keys off harness text", () => {
    // Belt and braces on the durable side: whatever reaches `memoryID` is content, not scaffolding.
    const exchange = SessionExtract.buildExchange([user("I live in Berlin"), assistant("noted"), steer(NUDGE)])
    expect(exchange).not.toContain(STEER_PROVENANCE_PREFIX)
  })
})

describe("auto-recall (the retrieval leg of B2)", () => {
  test("the query is the newest REAL user text, not the newest steer", () => {
    expect(SessionRecall.recallQuery([user("what do I prefer?"), assistant("…"), steer(NUDGE)])).toBe(
      "what do I prefer?",
    )
  })

  test("no real user turn → no query at all (never a harness-text search)", () => {
    expect(SessionRecall.recallQuery([steer(NUDGE)])).toBeUndefined()
    expect(SessionRecall.recallQuery([])).toBeUndefined()
  })
})

describe("the consumers that already filtered still do, through the shared predicate", () => {
  test("SessionTitle.firstRealUserText skips steers and blanks (unchanged behaviour)", () => {
    expect(SessionTitle.firstRealUserText([steer("You appear stuck."), user("   "), user("  add dark mode  ")])).toBe(
      "add dark mode",
    )
    expect(SessionTitle.firstRealUserText([])).toBeUndefined()
  })

  test("doom-loop: a steer does NOT reset the tool-call window, a real user message does", () => {
    // Without this the doom-loop's own nudge would wipe the very streak it fired for (the A2 regression).
    expect(
      toolCallsSinceLastUser([
        user("do the thing"),
        assistantCall("bash", { command: "make" }, true),
        steer(NUDGE),
        assistantCall("bash", { command: "make" }, true),
      ]).length,
    ).toBe(2)
    const afterRealUser = toolCallsSinceLastUser([
      user("old goal"),
      assistantCall("bash", { command: "make" }, true),
      steer(NUDGE),
      user("new goal"),
      assistantCall("read", { path: "x" }, false),
    ])
    expect(afterRealUser.length).toBe(1)
    expect(afterRealUser[0]!.name).toBe("read")
  })

  test("context-pack: the wire-shaped twin agrees with the transcript-shaped predicate", () => {
    expect(isRealUserMessage(Message.user("task"))).toBe(true)
    expect(isRealUserMessage(Message.user(applySteerProvenance(NUDGE)))).toBe(false)
    expect(isRealUserMessage(Message.assistant("hello"))).toBe(false)
    // A demoted mid-history system message must stay invisible to the anchor pass.
    const demoted = demoteSystemMessages([Message.system("a system note")])
    expect(isRealUserMessage(demoted[0]!)).toBe(false)
  })
})

// ── layer 2: the source ledger ──────────────────────────────────────────────────────────────────
//
// The behaviour tests above pin the six call sites that exist TODAY. This layer is what makes a
// SEVENTH fail loudly: any new code under `src/session/**` that discriminates on the user role must
// either route through the shared provenance vocabulary or be named here, with a reason.

const CORE_SRC = path.join(import.meta.dir, "..", "src")
const SESSION_SRC = path.join(CORE_SRC, "session")

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return []
    return [full]
  })

const relative = (root: string, file: string) => path.relative(root, file).split(path.sep).join("/")

const sessionFiles = walk(SESSION_SRC).map((file) => ({ id: relative(SESSION_SRC, file), file }))
const coreFiles = walk(CORE_SRC).map((file) => ({ id: relative(CORE_SRC, file), file }))
const source = (file: string) => fs.readFileSync(file, "utf8")

/** Code that asks "is this the user role?" — a comparison or a switch arm, never a construction. */
const USER_ROLE_DISCRIMINATOR = /\b(?:type|role)\s*(?:===|!==)\s*"user"|\bcase\s+"user"\s*:/

/** Any way of asking the provenance question through the shared module. */
const PROVENANCE_VOCABULARY =
  /isSteerText|isRealUserTurn|isRealUserMessage|lastRealUser|firstRealUser|STEER_PROVENANCE_PREFIX|steer-provenance/

/**
 * Files permitted to name the raw constant. Everything else must use a named helper — that is what
 * makes the wrong thing hard: there is no ergonomic way to hand-roll the check.
 */
const PREFIX_SPEAKERS = new Map<string, string>([
  ["session/steer-provenance.ts", "defines it"],
  ["session/input.ts", "re-exports it for existing callers"],
  [
    "session/runner/strict.ts",
    "PENDING (B2): `lastUserText` still hand-rolls `startsWith` — converge it onto `lastRealUserText`",
  ],
])

/**
 * Files that discriminate on the user role WITHOUT asking the provenance question. Pinned by name so
 * the list can only shrink: a new unfiltered read fails, and so does a row that no longer applies.
 */
const UNFILTERED_USER_ROLE_READS = new Map<string, string>([
  // `compaction.ts` was here (the seventh site): `serialize()` rendered a steer as `[User]: …`, so
  // harness instruction text was attributed to the user inside the DURABLE compaction summary. It
  // now relabels steers via `isSteerText`/`stripSteerProvenance` — covered by
  // `test/session-compaction.test.ts`, and the stale-row test below is what deleted this entry.
  [
    "runner/to-llm-message.ts",
    "DELIBERATE: lowering to the wire, not a read of what the user said — the model MUST see the steer",
  ],
])

describe("the ledger scan itself", () => {
  test("guards the guard: the sweep found the modules this unit is about", () => {
    // A broken walk would make every assertion below vacuously true.
    expect(sessionFiles.length).toBeGreaterThan(15)
    const ids = sessionFiles.map((entry) => entry.id)
    for (const expected of [
      "steer-provenance.ts",
      "title.ts",
      "compaction.ts",
      "runner/extract.ts",
      "runner/recall.ts",
      "runner/doom-loop.ts",
      "runner/context-pack.ts",
      "runner/strict.ts",
      "runner/to-llm-message.ts",
    ]) {
      expect(ids).toContain(expected)
    }
  })

  test("the discriminator pattern matches reads and ignores constructions", () => {
    expect(USER_ROLE_DISCRIMINATOR.test('if (message.type === "user") {')).toBe(true)
    expect(USER_ROLE_DISCRIMINATOR.test('if (message.type !== "user") continue')).toBe(true)
    expect(USER_ROLE_DISCRIMINATOR.test('message.role === "user" && ok')).toBe(true)
    expect(USER_ROLE_DISCRIMINATOR.test('    case "user":')).toBe(true)
    expect(USER_ROLE_DISCRIMINATOR.test('Message.make({ role: "user", content })')).toBe(false)
    expect(USER_ROLE_DISCRIMINATOR.test('return { type: "user", text }')).toBe(false)
  })

  test("every ledger row names a file that still exists", () => {
    for (const id of PREFIX_SPEAKERS.keys()) expect(fs.existsSync(path.join(CORE_SRC, id))).toBe(true)
    for (const id of UNFILTERED_USER_ROLE_READS.keys()) expect(fs.existsSync(path.join(SESSION_SRC, id))).toBe(true)
  })
})

describe("the steer predicate is the only form", () => {
  test("no module outside the ledger names STEER_PROVENANCE_PREFIX — helpers only", () => {
    const speakers = coreFiles
      .filter((entry) => /STEER_PROVENANCE_PREFIX/.test(source(entry.file)))
      .map((entry) => entry.id)
      .filter((id) => !PREFIX_SPEAKERS.has(id))
    expect(speakers).toEqual([])
  })

  test("session sources are plain text, so a text-based audit cannot silently skip one", () => {
    // A raw NUL byte makes ripgrep classify a file as BINARY and skip it — `runner/extract.ts` and
    // `runner/doom-loop.ts` both carried one (an intended `\x00` escape written as the character),
    // which is exactly how a provenance audit would have missed the two defective files.
    //
    // ⚠️ THE GENERAL CHECK NOW LIVES IN `test/invisible-characters.test.ts` — use that one. This
    // check is kept because the ledger scan below is the thing it protects, but it did NOT stop the
    // defect recurring: it sees only `src/session/**`, and `walk` above skips `*.test.ts`. Three
    // more files picked up the same idiom where it cannot look (`src/tool/kb.ts`,
    // `llm/src/protocols/utils/tool-recovery.ts`, and `app/src/constants/links.test.ts`, whose five
    // NULs this project added while this test was green). The repo-wide guard crosses package
    // boundaries, includes tests, and covers the wider class — homoglyphs and zero-width characters
    // as well as NUL. A narrow invariant is not a small version of a general one; it is a hole.
    const binary = sessionFiles.filter((entry) => fs.readFileSync(entry.file).includes(0)).map((entry) => entry.id)
    expect(binary).toEqual([])
  })
})

describe("every user-role read under session/ answers the provenance question", () => {
  const discriminators = sessionFiles.filter((entry) => USER_ROLE_DISCRIMINATOR.test(source(entry.file)))

  test("a new unfiltered read fails here — route it through session/steer-provenance.ts", () => {
    const unfiltered = discriminators
      .filter((entry) => !PROVENANCE_VOCABULARY.test(source(entry.file)))
      .map((entry) => entry.id)
      .filter((id) => !UNFILTERED_USER_ROLE_READS.has(id))
    expect(unfiltered).toEqual([])
  })

  test("a ledger row that no longer applies fails here — delete it", () => {
    const stale = [...UNFILTERED_USER_ROLE_READS.keys()].filter((id) => {
      const entry = discriminators.find((candidate) => candidate.id === id)
      return entry === undefined || PROVENANCE_VOCABULARY.test(source(entry.file))
    })
    expect(stale).toEqual([])
  })
})
