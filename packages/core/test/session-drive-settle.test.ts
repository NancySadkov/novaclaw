import { describe, expect, test } from "bun:test"
import { SessionDrive } from "@novaclaw/core/session/runner/drive"

/** A child that forgets `exit` is recovered by another turn, never completed by inference. */

const now = 1_000
const fresh = () => SessionDrive.initialState(now)

describe("a sub-agent runs until explicit exit", () => {
  test("a sub-agent that never exited keeps driving", () => {
    const decision = SessionDrive.decide({ type: "sub-agent" }, fresh(), now)
    expect(decision.kind).toBe("continue")
    if (decision.kind !== "continue") throw new Error("expected continue")
    expect(decision.message).toContain("parent remains waiting")
    expect(decision.message).toContain("`exit`")
  })

  test("a sub-agent that DID exit is left alone — one completion per session", () => {
    // The result check runs before the sub-agent arm on purpose: `exit` has already published
    // `Completed`, and settling again would publish a second completion for one session.
    expect(SessionDrive.decide({ type: "sub-agent", result: "done" }, fresh(), now)).toEqual({ kind: "terminated" })
    // `exit` records "" for a bare call, so empty-string is still a RESULT and still terminal.
    expect(SessionDrive.decide({ type: "sub-agent", result: "" }, fresh(), now)).toEqual({ kind: "terminated" })
  })

  test("an INTERACTIVE session is never settled — nobody is joining it", () => {
    // ⚠️ The negative that matters most. Settling a session a human is talking to would mark their
    // chat "exited" the moment it went quiet, and `wait` has no claim on it.
    expect(SessionDrive.decide({ type: "interactive" }, fresh(), now)).toEqual({ kind: "idle" })
    expect(SessionDrive.decide({}, fresh(), now)).toEqual({ kind: "idle" })
    expect(SessionDrive.decide(undefined, fresh(), now)).toEqual({ kind: "idle" })
  })

  test("every autonomous type keeps driving regardless of elapsed rounds", () => {
    expect(SessionDrive.decide({ type: "goal-oriented" }, fresh(), now).kind).toBe("continue")
    expect(SessionDrive.decide({ type: "goal-oriented" }, fresh(), now).kind).toBe("continue")
    const spent = { rounds: Number.MAX_SAFE_INTEGER, startedAt: 0, stagnantRounds: 0 }
    expect(SessionDrive.decide({ type: "goal-oriented" }, spent, Number.MAX_SAFE_INTEGER).kind).toBe("continue")
    expect(SessionDrive.decide({ type: "sub-agent" }, spent, Number.MAX_SAFE_INTEGER).kind).toBe("continue")
  })

  test("an accepted exit makes a goal-oriented officer sleep, never terminate", () => {
    const decision = SessionDrive.decide({ type: "goal-oriented" }, fresh(), now, {
      acceptedExit: true,
      steps: [],
    })
    expect(decision).toMatchObject({ kind: "sleep", milliseconds: SessionDrive.UNATTENDED_SLEEP_MS })
  })

  test("an unknown thread type is stopped, not settled", () => {
    // Only `sub-agent` has a parent that might be blocked. A future type must opt in deliberately
    // rather than inherit completion semantics by falling through.
    expect(SessionDrive.decide({ type: "fork" }, fresh(), now)).toEqual({ kind: "idle" })
  })
})

describe("the grounding listing serves two callers with different limits", () => {
  // 🔴 Measured 2026-08-20: the set-completion drive finished 40 of 40 only because the PROMPT's
  // `MAX_LISTED_ENTRIES = 40` happened to equal the request. A request for the first 100 would have
  // been driven to 40 and told nothing about the other 60 — the coverage check inheriting a bound
  // that exists purely to keep a prompt message small.
  test("the default is the prompt's cap; a caller may ask for more", async () => {
    const { ProjectGrounding } = await import("@novaclaw/core/session/runner/project-grounding")
    const { UnfinishedSet } = await import("@novaclaw/core/session/runner/unfinished-set")
    const fs = await import("node:fs/promises")
    const os = await import("node:os")
    const path = await import("node:path")

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "listing-cap-"))
    try {
      for (let i = 0; i < 60; i++) await fs.writeFile(path.join(dir, `f${String(i).padStart(3, "0")}.png`), "x")

      const forPrompt = await ProjectGrounding.readListing(dir)
      expect(forPrompt?.entries.length).toBe(ProjectGrounding.MAX_LISTED_ENTRIES)
      // ⚠️ `total` stays honest at both limits — a truncated list that misreports the total is the
      // silent cap this repo's own rule forbids.
      expect(forPrompt?.total).toBe(60)

      const forDrive = await ProjectGrounding.readListing(
        dir,
        UnfinishedSet.MAX_STEER_ROUNDS * UnfinishedSet.STEER_BATCH,
      )
      expect(forDrive?.entries.length).toBe(60)
      expect(forDrive?.total).toBe(60)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
