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
