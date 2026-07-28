import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import { FinishReason } from "@novaclaw/llm"
import { FinishRecovery } from "./finish-recovery"
import { applySteerProvenance, isSteerText, STEER_PROVENANCE_PREFIX } from "../steer-provenance"

// F2 — output-token truncation recovery, ported from GitHub PR #4 (@DassaultFalconKing).
//
// The decision is tiny; what has to be pinned is the BOUND. Upstream's version read
// `state.recoveries === 0` and nothing ever wrote `state.recoveries`, so the "stop" arm was dead
// code and the guard against a truncation loop WAS a truncation loop. That defect type-checks and
// compiles green, so the two-strikes test below drives one state through repeated calls — it is the
// negative control for exactly that bug and fails against the upstream shape.

/** Every finish reason that is NOT a truncation — the full negative-control set, from the schema. */
const NON_LENGTH = FinishReason.literals.filter((reason) => reason !== "length")

describe("the provider vocabulary this unit keys on", () => {
  test('`@novaclaw/llm` really does report truncation as "length"', () => {
    // Claim #1 of the port, checked against the schema rather than assumed from the PR.
    expect(FinishReason.literals).toContain("length")
    expect(NON_LENGTH.length).toBeGreaterThan(0)
  })
})

describe("FinishRecovery.decide — the two-strikes bound", () => {
  test("first truncation steers back to the cutoff, the second stops the run", () => {
    const state = FinishRecovery.initialState()
    const first = FinishRecovery.decide("length", false, state)
    expect(first.kind).toBe("continue")
    const second = FinishRecovery.decide("length", false, state)
    expect(second.kind).toBe("stop")
  })

  test("THE UPSTREAM BUG: decide writes the counter it reads, so it can never steer forever", () => {
    // Upstream's `decide` only READ `state.recoveries`; with a caller that never incremented it,
    // this loop would answer "continue" ten times out of ten.
    const state = FinishRecovery.initialState()
    expect(state.recoveries).toBe(0)
    const kinds = Array.from({ length: 10 }, () => FinishRecovery.decide("length", false, state).kind)
    expect(kinds.filter((kind) => kind === "continue").length).toBe(FinishRecovery.MAX_RECOVERIES)
    expect(kinds.slice(FinishRecovery.MAX_RECOVERIES).every((kind) => kind === "stop")).toBe(true)
    expect(state.recoveries).toBe(FinishRecovery.MAX_RECOVERIES)
  })

  test("the ledger is per-state: a fresh drain re-arms the one recovery", () => {
    const drainOne = FinishRecovery.initialState()
    FinishRecovery.decide("length", false, drainOne)
    expect(FinishRecovery.decide("length", false, drainOne).kind).toBe("stop")
    // A new drain (any new user input) starts clean — the notice tells the user to send a message.
    expect(FinishRecovery.decide("length", false, FinishRecovery.initialState()).kind).toBe("continue")
  })

  test("the counter does not reset on a good turn — an alternating run still terminates", () => {
    const state = FinishRecovery.initialState()
    expect(FinishRecovery.decide("length", false, state).kind).toBe("continue")
    expect(FinishRecovery.decide("stop", false, state).kind).toBe("none")
    expect(FinishRecovery.decide("tool-calls", true, state).kind).toBe("none")
    expect(FinishRecovery.decide("length", false, state).kind).toBe("stop")
  })
})

describe("negative controls — what must stay untouched", () => {
  test("no non-length finish is ever recovered, and none of them burns the budget", () => {
    for (const reason of NON_LENGTH) {
      const state = FinishRecovery.initialState()
      expect(FinishRecovery.decide(reason, false, state).kind).toBe("none")
      expect(FinishRecovery.decide(reason, true, state).kind).toBe("none")
      expect(state.recoveries).toBe(0)
      // …and the recovery it never spent is still available to a real truncation.
      expect(FinishRecovery.decide("length", false, state).kind).toBe("continue")
    }
  })

  test("a turn that never settled (undefined finish) is not a truncation", () => {
    const state = FinishRecovery.initialState()
    expect(FinishRecovery.decide(undefined, false, state).kind).toBe("none")
    expect(state.recoveries).toBe(0)
  })

  test("a truncation the drain already continues past is left alone (the tool-call case)", () => {
    // finish=length WITH a pending tool call: the runner runs another step regardless, so steering
    // would inject a redundant nudge. It must also not consume the one recovery.
    const state = FinishRecovery.initialState()
    expect(FinishRecovery.decide("length", true, state).kind).toBe("none")
    expect(state.recoveries).toBe(0)
    expect(FinishRecovery.decide("length", false, state).kind).toBe("continue")
  })

  test("an unrelated string is not silently treated as a truncation", () => {
    const state = FinishRecovery.initialState()
    expect(FinishRecovery.decide("Length", false, state).kind).toBe("none")
    expect(FinishRecovery.decide("max_tokens", false, state).kind).toBe("none")
    expect(state.recoveries).toBe(0)
  })
})

describe("what the model and the user are actually told", () => {
  const continued = FinishRecovery.decide("length", false, FinishRecovery.initialState())
  const stopped = (() => {
    const state = FinishRecovery.initialState()
    FinishRecovery.decide("length", false, state)
    return FinishRecovery.decide("length", false, state)
  })()

  test("the continuation names the cutoff, forbids redoing work, and demands one small step", () => {
    if (continued.kind !== "continue") throw new Error("expected continue")
    expect(continued.message).toContain("output-token limit")
    expect(continued.message.toLowerCase()).toContain("do not repeat")
    expect(continued.message.toLowerCase()).toContain("re-read")
  })

  test("the continuation is harness text — it goes out through the steer primitive, prefixed", () => {
    if (continued.kind !== "continue") throw new Error("expected continue")
    // The message must NOT hand-roll the prefix (only `session/steer-provenance.ts` owns it), and
    // must be recognisable as a steer once `SessionInput.steer` has stamped it — which is what
    // keeps auto-extraction, auto-recall and the title pass from reading it as the user speaking.
    expect(continued.message.startsWith(STEER_PROVENANCE_PREFIX)).toBe(false)
    expect(isSteerText(continued.message)).toBe(false)
    expect(isSteerText(applySteerProvenance(continued.message))).toBe(true)
  })

  test("the stop notice names the real fix and the way out, not a truncation loop", () => {
    if (stopped.kind !== "stop") throw new Error("expected stop")
    expect(stopped.notice).toContain("⏸️")
    expect(stopped.notice.toLowerCase()).toContain("budget")
    expect(stopped.notice.toLowerCase()).toContain("smaller")
    expect(stopped.notice.toLowerCase()).toContain("send any message")
  })
})

// ── the wiring, asserted at the SOURCE ───────────────────────────────────────────────────────────
//
// Nothing in the fast suite executes `runner/llm.ts` (its only live exercise is
// `tests/os-foundation-smoke.ts` against the Spark), and every invariant below compiles green when
// violated: routing the steer through `events.publish` instead of `SessionInput.steer` would strip
// the provenance prefix, and dropping the outer-loop break would leave the two-strike bound
// decorative because self-drive would immediately re-steer. So they are pinned as text.

const RUNNER_LLM = path.join(import.meta.dir, "llm.ts")
const runnerSource = fs.readFileSync(RUNNER_LLM, "utf8")

describe("runner/llm.ts wiring", () => {
  test("guards the guard: the file was found and is the runner", () => {
    expect(runnerSource.length).toBeGreaterThan(10_000)
    expect(runnerSource).toContain("SessionRunner.manualCompaction")
  })

  test("the settled provider finish reason travels out of the turn", () => {
    expect(runnerSource).toContain("finish: stepSettlement?.finish")
    expect(runnerSource).toContain("readonly finish: string | undefined")
  })

  test("the drain asks THIS module, with the turn's own finish reason", () => {
    expect(runnerSource).toContain('import { FinishRecovery } from "./finish-recovery"')
    expect(runnerSource).toContain("FinishRecovery.initialState()")
    expect(runnerSource).toContain("FinishRecovery.decide(result.finish, result.needsContinuation, finishRecovery)")
  })

  test("the continuation reaches the model ONLY through the provenance-stamping steer primitive", () => {
    expect(runnerSource).toContain("SessionInput.steer(db, events, input.sessionID, truncation.message)")
    // Exactly one use — a second would be a bypass (e.g. published raw as a Synthetic/user message).
    expect(runnerSource.split("truncation.message").length - 1).toBe(1)
  })

  test("the stop arm surfaces a notice and ends the RUN, not just the step loop", () => {
    expect(runnerSource).toContain("text: truncation.notice")
    expect(runnerSource).toContain("truncationHalted = true")
    expect(runnerSource).toContain("if (exitedMidDrain || truncationHalted) break")
  })
})

describe('"length" is known in exactly one place under session/', () => {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return walk(full)
      if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return []
      return [full]
    })

  test("no OTHER session module hand-rolls a finish-reason truncation check", () => {
    // This module is the one place allowed to name the literal (and even here it does so through a
    // `FinishReason`-typed constant, so a schema rename breaks the build). A hit anywhere else is by
    // definition a second, unbounded implementation of this rule.
    const sessionSrc = path.join(import.meta.dir, "..")
    const files = walk(sessionSrc)
    expect(files.length).toBeGreaterThan(15)
    const offenders = files
      .map((file) => ({ id: path.relative(sessionSrc, file).split(path.sep).join("/"), file }))
      .filter((entry) => entry.id !== "runner/finish-recovery.ts")
      .filter((entry) => /(?:===|!==)\s*"length"/.test(fs.readFileSync(entry.file, "utf8")))
      .map((entry) => entry.id)
    expect(offenders).toEqual([])
  })
})
