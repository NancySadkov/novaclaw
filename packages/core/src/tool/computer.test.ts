import { describe, expect, test } from "bun:test"
import { ComputerTool } from "./computer"
import { ComputerActions } from "../computer/actions"


const input = (over: Partial<ComputerTool.Input>): ComputerTool.Input =>
  ({ action: "screenshot", ...over }) as ComputerTool.Input

// The tool's schema is FLAT (action + optional x/y/text/keys/…) while the action layer takes a
// discriminated union. A flat object is what a model fills reliably; this translation is the price,
// and it is where a missing field has to become an honest refusal rather than a default that clicks
// somewhere arbitrary.
describe("flat input becomes an action, or an honest refusal", () => {
  test("a move without coordinates is refused, not defaulted to a corner", () => {
    expect(ComputerTool.toAction(input({ action: "move" }))).toEqual({ error: "move needs both x and y" })
    expect(ComputerTool.toAction(input({ action: "move", x: 10 }))).toEqual({ error: "move needs both x and y" })
    expect(ComputerTool.toAction(input({ action: "move", x: 10, y: 20 }))).toEqual({
      kind: "move",
      point: { x: 10, y: 20 },
    })
  })

  test("a click without coordinates is legal — it clicks where the pointer already is", () => {
    // Distinct from `move`: the pointer has a position, so this is meaningful rather than ambiguous.
    expect(ComputerTool.toAction(input({ action: "click" }))).toEqual({ kind: "click", button: "left" })
    expect(ComputerTool.toAction(input({ action: "click", button: "right", x: 1, y: 2 }))).toEqual({
      kind: "click",
      button: "right",
      point: { x: 1, y: 2 },
    })
  })

  test("type and key refuse rather than sending nothing", () => {
    expect(ComputerTool.toAction(input({ action: "type" }))).toEqual({ error: "type needs text" })
    expect(ComputerTool.toAction(input({ action: "key" }))).toEqual({ error: "key needs keys" })
    expect(ComputerTool.toAction(input({ action: "type", text: "hi" }))).toEqual({ kind: "type", text: "hi" })
  })

  test("scroll needs a direction but defaults its amount", () => {
    expect(ComputerTool.toAction(input({ action: "scroll" }))).toEqual({ error: "scroll needs a direction" })
    expect(ComputerTool.toAction(input({ action: "scroll", direction: "down" }))).toEqual({
      kind: "scroll",
      direction: "down",
      amount: 3,
    })
  })

  test("every declared action maps to something — no silent hole in the switch", () => {
    for (const action of ["screenshot", "move", "click", "double_click", "type", "key", "scroll", "cursor"] as const) {
      const result = ComputerTool.toAction(
        input({ action, x: 1, y: 2, text: "t", keys: "Return", direction: "up" }),
      )
      expect("error" in result).toBe(false)
    }
  })
})

describe("the whole pipeline: flat input -> argv", () => {
  test("a model-authored click becomes argv the shell never sees", () => {
    const action = ComputerTool.toAction(input({ action: "click", x: 550, y: 400 }))
    if ("error" in action) throw new Error("unexpected refusal")
    const built = ComputerActions.build(action, { display: ":99", screenshotPath: "/tmp/s.png" })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.argv).toEqual([
      ["xdotool", "mousemove", "550", "400"],
      ["xdotool", "click", "1"],
    ])
    expect(built.env).toEqual({ DISPLAY: ":99" })
  })

  test("hostile typed text survives as one argv element all the way through", () => {
    const payload = "; rm -rf ~ $(id)"
    const action = ComputerTool.toAction(input({ action: "type", text: payload }))
    if ("error" in action) throw new Error("unexpected refusal")
    const built = ComputerActions.build(action, { display: ":99", screenshotPath: "/tmp/s.png" })
    if (!built.ok) throw new Error("unexpected rejection")
    expect(built.argv[0]?.at(-1)).toBe(payload)
  })
})

describe("unconfigured declines by NAMING the knob", () => {
  test("the message says what to set and why it is not inherited", () => {
    // Ruling 2 — an unavailable subsystem names itself. Unconfigured is the COMMON case (a Windows
    // laptop, a headless server), so this is the message most callers meet, and it is the one an
    // agent needs in order to repair the instance itself.
    expect(ComputerTool.UNCONFIGURED).toContain("computer.display")
    expect(ComputerTool.UNCONFIGURED).toContain("never inherited")
  })

  test("the tool is named `computer`, which is also its permission action", () => {
    expect(ComputerTool.name).toBe("computer")
  })
})

describe("the region rides the flat input through to argv", () => {
  test("no region asked for, no region emitted", () => {
    // The crop must be something the model chose, never something it received: a silently cropped
    // frame offsets every coordinate the grounder reads off it, and the image does not say so.
    expect(ComputerTool.toAction(input({ action: "screenshot" }))).toEqual({ kind: "screenshot" })
  })

  test("x,y,w,h reaches the action union, and then the argv scrot takes", () => {
    const action = ComputerTool.toAction(input({ action: "screenshot", region: "100,120,240,180" }))
    expect(action).toEqual({ kind: "screenshot", region: { x: 100, y: 120, width: 240, height: 180 } })
    const built = ComputerActions.build(action as ComputerActions.Action, {
      display: ":99",
      screenshotPath: "/tmp/shot.png",
    })
    expect(built.ok).toBe(true)
    if (built.ok) expect([...built.argv[0]!]).toEqual(["scrot", "-o", "-a", "100,120,240,180", "/tmp/shot.png"])
  })

  test("surrounding whitespace is tolerated — a model spacing a list is not an error", () => {
    expect(ComputerTool.parseRegion(" 1 , 2 , 3 , 4 ")).toEqual({ x: 1, y: 2, width: 3, height: 4 })
  })

  test("🔴 a HALF-filled region cannot be expressed, and is refused by name", () => {
    // The property that justified a nested object before it was measured at 965 bytes of resident
    // schema: three numbers is not a rectangle, and defaulting the fourth is a wrong crop that
    // reports success. The string form keeps the property for a fraction of the size.
    for (const raw of ["1,2,3", "1,2", "", "1,2,3,4,5"]) {
      const parsed = ComputerTool.parseRegion(raw)
      expect("error" in parsed).toBe(true)
      if ("error" in parsed) expect(parsed.error).toContain("x,y,width,height")
    }
  })

  test("a non-numeric part is refused, and the message names WHICH part", () => {
    const parsed = ComputerTool.parseRegion("10,20,wide,40")
    expect("error" in parsed).toBe(true)
    if ("error" in parsed) expect(parsed.error).toContain("width")
  })

  test("the refusal travels out of toAction rather than becoming a full-screen capture", () => {
    // Silently falling back to the whole screen would be the worst outcome: the model asked a
    // question about one region and would get an answer about a different picture.
    const action = ComputerTool.toAction(input({ action: "screenshot", region: "nonsense" }))
    expect("error" in action).toBe(true)
  })

  test("range and integer rules are NOT duplicated here — they stay in the action layer", () => {
    // parseRegion accepts what is arithmetically a region; `build` is the one module that knows what
    // scrot will take. Two copies of that rule is how the two drift apart.
    expect(ComputerTool.parseRegion("10,10,0,0")).toEqual({ x: 10, y: 10, width: 0, height: 0 })
    const built = ComputerActions.build(
      { kind: "screenshot", region: { x: 10, y: 10, width: 0, height: 0 } },
      { display: ":99", screenshotPath: "/tmp/shot.png" },
    )
    expect(built.ok).toBe(false)
  })

  test("a region on a NON-screenshot action is ignored rather than half-applied", () => {
    const action = ComputerTool.toAction(input({ action: "click", x: 5, y: 6, region: "0,0,9,9" }))
    expect(action).toEqual({ kind: "click", button: "left", point: { x: 5, y: 6 } })
  })
})
