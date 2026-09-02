import { describe, expect, test } from "bun:test"
import { ComputerEvidence } from "@novaclaw/core/computer/evidence"
import { ComputerLoop } from "@novaclaw/core/computer/loop"
import { WindowsComputer } from "@novaclaw/core/computer/windows-native"
import type { ComputerActions } from "@novaclaw/core/computer/actions"
import type { ComputerControlTarget } from "@novaclaw/core/computer/control-target"
import type { ComputerPrompt } from "@novaclaw/core/computer/prompt"

/**
 * Two Computer Use faults that are invisible to every other kind of check, because neither of them
 * errors, logs, or changes an exit code.
 *
 * 1. **One number, two meanings.** `x: 1` is a legal right-edge FRACTION and a legal LEFT-EDGE pixel,
 *    and the native Windows builder used to decide between them by looking at the number. Both
 *    readings are pinned below, because pinning only one leaves the conflation intact.
 * 2. **A crop is not a screen.** C3 captures a watch region a few percent of the frame's area to
 *    re-check a grounded point. That patch is the answer to one closed question and must not become
 *    the loop's idea of "the newest frame" — the planner is told *"Re-ground from this screen"* off
 *    that field, and the checkpoint adjudicator falls back to it whenever the after-frame fails.
 */

// ------------------------------------------------------------------------------------------------
// 1 — the coordinate space is DECLARED, and `x: 1` means two different things
// ------------------------------------------------------------------------------------------------

const target: ComputerControlTarget.WindowsWindow = {
  kind: "windows-window",
  windowHandle: "1844674407370955",
  processID: 42,
  executable: "dosbox-x.exe",
}

/** A deliberately non-round window: 1435x900 makes a fraction, a 0-1000 grid and a pixel disagree. */
const inspection: WindowsComputer.Inspection = {
  handle: target.windowHandle,
  processID: target.processID,
  executable: target.executable,
  title: "DOSBox-X",
  visible: true,
  minimized: false,
  foreground: true,
  x: 10,
  y: 20,
  width: 1435,
  height: 900,
}

const move = (point: ComputerActions.Point, space: Parameters<typeof WindowsComputer.build>[5]) =>
  WindowsComputer.build({ kind: "move", point }, target, inspection, "helper.ps1", "shot.png", space)

const xy = (built: WindowsComputer.Built): readonly [string, string] => {
  if (!built.ok) throw new Error(`expected argv, got a refusal: ${built.reason}`)
  const argv = built.argv[0]!
  return [argv[argv.indexOf("-X") + 1]!, argv[argv.indexOf("-Y") + 1]!] as const
}

describe("the Windows click path takes its coordinate space from the caller", () => {
  test("🔴 `x: 1` declared as a fraction is the RIGHT edge of the window", () => {
    // The whole defect in one line: `Number.isInteger(1)` is true, so the old inference read this as
    // 1/1000 of the window and moved to pixel 1 — the opposite edge, with exit 0 and no log.
    const [x, y] = xy(move({ x: 1, y: 0.5 }, "normalized-1"))
    console.log(`normalized-1 {x:1,y:0.5} on ${inspection.width}x${inspection.height} -> -X ${x} -Y ${y}`)
    expect([x, y]).toEqual(["1435", "450"])
  })

  test("🔴 `x: 1` declared as pixels is pixel 1 — the LEFT edge", () => {
    const [x, y] = xy(move({ x: 1, y: 450 }, "pixels"))
    console.log(`pixels {x:1,y:450} on ${inspection.width}x${inspection.height} -> -X ${x} -Y ${y}`)
    expect([x, y]).toEqual(["1", "450"])
  })

  test("the same `x: 1` on Holo's 0-1000 grid is a thousandth of the window", () => {
    // The third reading, so the pair above cannot be green merely because two spaces happen to agree.
    expect(xy(move({ x: 500, y: 500 }, "normalized-1000"))).toEqual(["718", "450"])
    expect(xy(move({ x: 500, y: 500 }, "pixels"))).toEqual(["500", "500"])
  })

  test("a click's move step is converted in the declared space too, not only `move`", () => {
    const built = WindowsComputer.build(
      { kind: "click", button: "left", point: { x: 1, y: 0.5 } },
      target,
      inspection,
      "helper.ps1",
      "shot.png",
      "normalized-1",
    )
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.argv[0]).toEqual(expect.arrayContaining(["-X", "1435", "-Y", "450"]))
  })

  test("🔴 a point outside the declared space is REFUSED, and the refusal names the space that fits", () => {
    const built = move({ x: 1300, y: 10 }, "normalized-1000")
    expect(built.ok).toBe(false)
    if (built.ok) return
    console.log(`refusal: ${built.reason}`)
    expect(built.reason).toContain("normalized-1000")
    // `alsoValidAs` is the actionable half: 1300 is a legal PIXEL on a 1435-wide window, so the fault
    // is a wrong declaration rather than a model that cannot ground.
    expect(built.reason).toContain("pixels")
  })
})

// ------------------------------------------------------------------------------------------------
// 2 — the pre-action watch crop never becomes `State.image`
// ------------------------------------------------------------------------------------------------

const spec: ComputerLoop.TaskSpec = {
  goal: "Open the Game Options dialog.",
  checkpoints: [{ id: "cp1", question: "Is the Game Options dialog visible?" }],
  budget: { maxSteps: 6, maxPromptTokens: 500_000 },
  space: "normalized-1000",
  viewport: { width: 1280, height: 800 },
  actionOptions: { display: ":99", screenshotPath: "/tmp/novaclaw-cu.png" },
}

const image = (tag: string): ComputerPrompt.Image => ({ mime: "image/png", data: `BASE64_${tag}` })

const captured = (tag: string): ComputerLoop.Event => ({
  kind: "captured",
  capture: ComputerEvidence.captured(`digest-${tag}`),
  image: image(tag),
})

/** Drive the reducer to the moment the pre-action critic is asked, and hand back both transitions. */
const toPreActionCritic = () => {
  let transition = ComputerLoop.start(spec)
  transition = ComputerLoop.next(transition.state, captured("start"))
  transition = ComputerLoop.next(transition.state, {
    kind: "adjudicated",
    text: JSON.stringify({ observed: "the main menu", checkpoint: "no" }),
  })
  expect(transition.command).toMatchObject({ kind: "capture" })
  transition = ComputerLoop.next(transition.state, captured("frame"))
  expect(transition.command.kind).toBe("ask-planner")
  transition = ComputerLoop.next(transition.state, {
    kind: "planner-replied",
    text: JSON.stringify({
      observation: "the main menu",
      action: { kind: "click", button: "left", target: "target-464-684" },
      expect: "The Game Options dialog is showing.",
    }),
  })
  while (transition.command.kind === "ask-grounder") {
    transition = ComputerLoop.next(transition.state, {
      kind: "grounder-replied",
      text: JSON.stringify({ x: 464, y: 684 }),
    })
  }
  if (transition.command.kind !== "capture" || transition.command.purpose !== "preaction")
    throw new Error(`expected the pre-action capture, got ${transition.command.kind}`)
  const region = transition.command.region
  const cropped = ComputerLoop.next(transition.state, captured("crop"))
  return { region, cropped }
}

describe("the pre-action watch crop is a witness, not the screen", () => {
  test("🔴 `State.image` after the watch comparison is the FRAME, not the crop", () => {
    const { region, cropped } = toPreActionCritic()
    const frameArea = spec.viewport.width * spec.viewport.height
    const cropArea = region === undefined ? frameArea : region.width * region.height
    console.log(
      `frame ${spec.viewport.width}x${spec.viewport.height} = ${frameArea}px; ` +
        `pre-action crop ${region?.width}x${region?.height} = ${cropArea}px ` +
        `(${((cropArea / frameArea) * 100).toFixed(1)}% of the frame)`,
    )
    // The crop must be small enough for the substitution to matter — otherwise this test would pass
    // on a build where "the crop" and "the frame" were the same picture.
    expect(cropArea).toBeLessThan(frameArea * 0.2)

    expect(cropped.command.kind).toBe("ask-preaction-critic")
    expect(cropped.state.image).toEqual(image("frame"))
    expect(cropped.state.image).not.toEqual(image("crop"))
  })

  test("the critic itself still gets the crop — the fix moves the picture, it does not withhold it", () => {
    const { cropped } = toPreActionCritic()
    if (cropped.command.kind !== "ask-preaction-critic") throw new Error("expected the pre-action critic")
    expect(cropped.command.prompt.image).toEqual(image("crop"))
  })

  test("🔴 the planner's re-ground repair is shown the frame when the critic refuses the point", () => {
    const { cropped } = toPreActionCritic()
    const refused = ComputerLoop.next(cropped.state, {
      kind: "preaction-critiqued",
      text: JSON.stringify({ approve: false, reason: "the point is on the window chrome" }),
    })
    if (refused.command.kind !== "ask-planner") throw new Error(`expected the planner, got ${refused.command.kind}`)
    expect(refused.command.prompt.user).toContain("Re-ground from this screen")
    expect(refused.command.prompt.image).toEqual(image("frame"))
  })

  test("🔴 and so is the checkpoint adjudicator when the after-frame capture fails", () => {
    const { cropped } = toPreActionCritic()
    const approved = ComputerLoop.next(cropped.state, {
      kind: "preaction-critiqued",
      text: JSON.stringify({ approve: true, reason: "the point is centred on the visible target" }),
    })
    expect(approved.command.kind).toBe("act")
    // The watch pair is intact, so this is NOT a capture-failed step — `frameAfter` is advisory and
    // the run continues. The event therefore carries no image, and the adjudicator falls back to
    // `State.image`: the exact state in which a crop would have been adjudicated as "the screen".
    const adjudicating = ComputerLoop.next(approved.state, {
      kind: "acted",
      evidence: {
        kind: "click",
        watchIdlePair: [ComputerEvidence.captured("w0"), ComputerEvidence.captured("w0")],
        watchAfter: ComputerEvidence.captured("w1"),
        frameIdlePair: [ComputerEvidence.captured("f0"), ComputerEvidence.captured("f0")],
        frameAfter: ComputerEvidence.captureFailed("scrot exited 1"),
      },
    })
    if (adjudicating.command.kind !== "ask-adjudicator")
      throw new Error(`expected the adjudicator, got ${adjudicating.command.kind}`)
    expect(adjudicating.command.prompt.image).toEqual(image("frame"))
    expect(adjudicating.command.prompt.image).not.toEqual(image("crop"))
  })
})
