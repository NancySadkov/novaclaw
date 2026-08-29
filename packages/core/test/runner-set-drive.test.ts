import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { LLMEvent } from "@novaclaw/llm"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { HARNESS_SESSION, completeTurn, drive, makeRunnerHarness } from "./fixture/runner-harness"

/**
 * ── THE SET DRIVE, AT ITS CALL SITE ──────────────────────────────────────────────────────────────
 *
 * 🔴 **The LAST of five harness drives to get one, and the one this programme argues about.** Four
 * suites already cover the set machinery — `session-set-grounding`, `session-set-latch`,
 * `session-drive-settle`, `session-set-drive-withholds-spawn` — and **not one of them uses
 * `makeRunnerHarness`.** They are all pure-module. So `runner/llm.ts`'s `harness.drives.set` gate had
 * never been executed by any test, in either position, and an "unaided" baseline that switched it off
 * was trusting a branch nothing had run.
 *
 * ⚠️ **`reground` is switched OFF in BOTH arms here, on purpose.** Both drives speak at the same
 * finish, and a test that let both talk would be asserting on whichever message happened to arrive —
 * which is how a passing test ends up measuring the wrong drive.
 *
 * ⚠️ **The reads are scripted to FAIL** (the fixture registers only `echo` and `defect`, so `read` is
 * an unknown tool) and they still count as opened, because `openedThisTurn` reads tool-call INPUTS
 * and never looks at `call.failed`. That is a defect in its own right — filed in
 * `todo/delegation.md` — and here it is what makes the drive drivable at all. **If that defect is
 * ever fixed, this test breaks**, and its replacement needs a `read` tool in the fixture.
 */

const CUED = "Describe every image in the folder."

const corpus = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "set-drive-"))
  mkdirSync(dir, { recursive: true })
  const names = ["a.png", "b.png", "c.png", "d.png", "e.png"]
  for (const name of names) writeFileSync(path.join(dir, name), "x")
  return { dir, names, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** One turn that "reads" two of the five, then a confident finish. */
const turns = (dir: string) => [
  [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolCall({ id: "r-a", name: "read", input: { path: path.join(dir, "a.png") } }),
    LLMEvent.toolCall({ id: "r-b", name: "read", input: { path: path.join(dir, "b.png") } }),
    LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
    LLMEvent.finish({ reason: "tool-calls" }),
  ],
  completeTurn("done-1", "All done — every image in the folder has been described."),
  completeTurn("done-2", "All done — every image in the folder has been described."),
]

const STEER_PREFIX = "[Automated NovaClaw check"

const run = async (label: string, set: boolean) => {
  const { dir, cleanup } = corpus()
  try {
    const harness = makeRunnerHarness({ turns: turns(dir) })
    // reground OFF in both arms — see the header. `set` is the only thing that differs.
    harness.controls.harnessDrives = { reground: false, set }
    let transcript: { type: string; text?: string }[] = []
    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: CUED }), resume: false })
        yield* session.resume(HARNESS_SESSION)
        transcript = (yield* session.context(HARNESS_SESSION)) as typeof transcript
      }),
      label,
    )
    const steers = transcript
      .filter((m) => m.type === "user" && (m.text ?? "").startsWith(STEER_PREFIX))
      .map((m) => m.text ?? "")
    return { steers }
  } finally {
    cleanup()
  }
}

describe("the runner asks harness_drives before driving an unfinished set", () => {
  // ⭐ THE CONTROL. Without it, the OFF case below passes just as well when the drive is broken and
  // never fires at all — half a control, the shape `notes/` names outright.
  test("ON (the default): three unopened files in the set produce a steer", async () => {
    const { steers } = await run("set drive on", true)
    expect(steers.length, "the drive must speak when the set is unfinished").toBeGreaterThan(0)
    // It must name what is LEFT, not what was done — "you missed some" is not actionable.
    expect(steers.join(" ")).toContain("c.png")
  })

  // 🔴 THE MEASUREMENT THIS EXISTS FOR — an unaided baseline is only unaided if this is silent.
  test("OFF: the same unfinished set is left alone", async () => {
    const { steers } = await run("set drive off", false)
    expect(steers, "with the drive off NOTHING may steer the model").toEqual([])
  })
})
