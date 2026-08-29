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
 * ⚠️ **These reads SUCCEED.** The fixture registers a real `read` behind `withReadTool`, added for
 * this suite: a drive can only be driven by the tool it watches, and a harness with no `read` can
 * only produce FAILING reads — which is a different case, asserted separately below.
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

/** Reads a.png (succeeds) and b.png AFTER deleting it (fails), then finishes confidently. */
const runWithMissing = async (label: string) => {
  const { dir, cleanup } = corpus()
  try {
    // b.png is removed, so its scripted read FAILS. (A directory of the same name was tried first;
    // the drive correctly filters directories out of the enumerable set, so it could not serve here.)
    rmSync(path.join(dir, "b.png"))
    const harness = makeRunnerHarness({ turns: turns(dir), withReadTool: true })
    harness.controls.harnessDrives = { reground: false, set: true }
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
    return {
      steers: transcript
        .filter((m) => m.type === "user" && (m.text ?? "").startsWith(STEER_PREFIX))
        .map((m) => m.text ?? ""),
    }
  } finally {
    cleanup()
  }
}

const run = async (label: string, set: boolean) => {
  const { dir, cleanup } = corpus()
  try {
    const harness = makeRunnerHarness({ turns: turns(dir), withReadTool: true })
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

/** Reads a.png and b.png after deleting BOTH — every read fails, so `opened` is empty. */
const runAllReadsFailed = async (label: string) => {
  const { dir, cleanup } = corpus()
  try {
    rmSync(path.join(dir, "a.png"))
    rmSync(path.join(dir, "b.png"))
    const harness = makeRunnerHarness({ turns: turns(dir), withReadTool: true })
    harness.controls.harnessDrives = { reground: false, set: true }
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
    return {
      steers: transcript
        .filter((m) => m.type === "user" && (m.text ?? "").startsWith(STEER_PREFIX))
        .map((m) => m.text ?? ""),
    }
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

  /**
   * 🔴 **A READ THAT FAILED IS NOT AN OPENED FILE.**
   *
   * `openedThisTurn` keeps every call named `read` whose input parses and never looks at
   * `call.failed`, which the same record carries. So a read that ERRORED — a missing file, a locked
   * one, a refusal — counts as done, and the drive stops steering toward the one file the model
   * demonstrably could not see. That is the drive agreeing that undone work is finished, which is the
   * single thing it exists to prevent.
   *
   * ⚠️ The fix is NOT to filter `failed` out of the shared list. The same list also derives
   * `setDirectory`, and a turn whose reads all failed would then produce an empty set, no directory,
   * and a fallback to `location.directory` — which is exactly the bug report §11 closed. The two uses
   * are split: WHERE the set lives comes from every read ATTEMPTED, what is DONE from those that
   * SUCCEEDED.
   */
  test("a read that FAILED is not counted as opened", async () => {
    const { steers } = await runWithMissing("set drive failed read")
    expect(steers.length, "the drive must still speak").toBeGreaterThan(0)
    /**
     * Two reads were scripted; one succeeded. The steer's own arithmetic is the assertion, because it
     * is the number the MODEL is told and the number the drive reasons with.
     *
     * ⚠️ Asserted on the count rather than on b.png appearing in the remaining list. b.png is gone
     * from the folder, so no correct implementation could name it — and a directory stand-in does not
     * work either, since the drive filters directories out of the set. The count is the claim that
     * survives both.
     */
    expect(steers[0], "a failed read must not inflate the opened count").toContain("opened 1 file")
  })

  /**
   * 🔴 **THE OTHER HALF OF THE SPLIT — and why filtering the shared list would have been wrong.**
   *
   * Every read here FAILS, so `opened` is empty. If `setDirectory` were derived from `opened`, it
   * would get an empty list, return `undefined`, and the drive would fall back to
   * `location.directory` — enumerating the session root instead of the folder the model is working
   * in. That is exactly the bug report §11 closed (`set.available: 2` for 40-, 100- and 400-file
   * corpora alike). Deriving it from ATTEMPTED reads keeps the directory right even when nothing
   * succeeded.
   *
   * ⚠️ This case exists because poisoning found the gap: reverting `setDir` to `opened` left the rest
   * of this suite green.
   */
  test("every read failed — the drive still enumerates the RIGHT folder", async () => {
    const { steers } = await runAllReadsFailed("set drive all reads failed")
    expect(steers.length, "the drive must speak — zero opened is the case that most needs it").toBeGreaterThan(0)
    expect(steers[0], "the folder the model was READING is the set, even with no successful read").toContain("c.png")
    // The ZERO-opened variant, which is a different sentence from the "you have opened N" one —
    // and the branch whose own comment calls it "the zero case is the one that most needs steering".
    expect(steers[0]).toContain("have not opened any of them yet")
  })
})
