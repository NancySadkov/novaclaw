import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { DateTime, Effect, Schema } from "effect"
import { Model, type ToolContent } from "@novaclaw/llm"
import * as OpenAIChat from "@novaclaw/llm/protocols/openai-compatible-chat"
import { ComputerTool } from "./computer"
import { Tool } from "./tool"
import { ComputerActions } from "../computer/actions"
import { ComputerControlTarget } from "../computer/control-target"
import { ConfigComputer } from "../config/computer"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"
import { SessionMessage } from "../session/message"
import { type SessionLike } from "../session/config-resolve"
import { SessionSchema } from "../session/schema"
import { SessionOrigin } from "../session/origin"
import { toLLMMessages, type InputCapabilities } from "../session/runner/to-llm-message"

const input = (over: Partial<ComputerTool.Input>): ComputerTool.Input =>
  ({ action: "screenshot", ...over }) as ComputerTool.Input

test("the default capture is a bounded browser-loop format", () => {
  expect(path.extname(ConfigComputer.DEFAULT_SCREENSHOT_PATH)).toBe(".jpg")
})

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

  test("normalizes the computer-use keyboard dialects observed from Holo", () => {
    expect(ComputerTool.toAction(input({ action: "keypress", keys: ["CTRL", "O"] }))).toEqual({
      kind: "key",
      keys: "CTRL+O",
    })
    expect(ComputerTool.toAction(input({ action: "keyDown", buttons: ["ctrl", "o"] }))).toEqual({
      kind: "key",
      keys: "ctrl+o",
    })
    expect(ComputerTool.toAction(input({ action: "key", button: "ctrl o" }))).toEqual({
      kind: "key",
      keys: "ctrl+o",
    })
    expect(ComputerTool.toAction(input({ action: "click", button: "ctrl o" }))).toEqual({
      error: "click button must be left, middle, or right — got ctrl o",
    })
    expect(ComputerTool.toAction(input({ action: "mouse_move", x: 0.15, y: 0.55 }))).toEqual({
      kind: "move",
      point: { x: 0.15, y: 0.55 },
    })
    expect(ComputerTool.toAction(input({ action: "press_key", key: "enter" }))).toEqual({
      kind: "key",
      keys: "enter",
    })
    expect(ComputerTool.toAction(input({ action: "left_click", x: 10, y: 20 }))).toEqual({
      kind: "click",
      button: "left",
      point: { x: 10, y: 20 },
    })
    expect(ComputerTool.toAction(input({ action: "click", double: true, x: 540, y: 445 }))).toEqual({
      kind: "double_click",
      point: { x: 540, y: 445 },
    })
  })

  test("decodes Holo's numeric-string coordinates but not invented null spellings", () => {
    const decoded = Schema.decodeUnknownSync(ComputerTool.Input)({ action: "click", x: "280", y: "0.48" })
    expect(ComputerTool.toAction(decoded)).toEqual({
      kind: "click",
      button: "left",
      point: { x: 280, y: 0.48 },
    })
    expect(() => Schema.decodeUnknownSync(ComputerTool.Input)({ action: "click", x: "None", y: "480" })).toThrow()
  })

  test("scroll needs a direction but defaults its amount", () => {
    expect(ComputerTool.toAction(input({ action: "scroll" }))).toEqual({
      error: "scroll needs a direction or non-zero delta_y",
    })
    expect(ComputerTool.toAction(input({ action: "scroll", direction: "down" }))).toEqual({
      kind: "scroll",
      direction: "down",
      amount: 3,
    })
  })

  test("normalizes Holo's measured pixel-style scroll dialects", () => {
    expect(ComputerTool.toAction(input({ action: "scroll", direction: "down", height: 800 }))).toEqual({
      kind: "scroll",
      direction: "down",
      amount: 7,
    })
    expect(ComputerTool.toAction(input({ action: "scroll", delta_y: -200 }))).toEqual({
      kind: "scroll",
      direction: "down",
      amount: 2,
    })
    expect(ComputerTool.toAction(input({ action: "scroll", direction: "down", amount: "800" as any }))).toEqual({
      kind: "scroll",
      direction: "down",
      amount: 7,
    })
    expect(ComputerTool.toAction(input({ action: "scroll", direction: -800 as any, height: 800 }))).toEqual({
      kind: "scroll",
      direction: "down",
      amount: 7,
    })
    expect(ComputerTool.toAction(input({ action: "scroll_down", speed: -500 }))).toEqual({
      kind: "scroll",
      direction: "down",
      amount: 4,
    })
    expect(ComputerTool.toAction(input({ action: "click_element", x: 20, y: 30 }))).toEqual({
      kind: "click",
      button: "left",
      point: { x: 20, y: 30 },
    })
    expect(ComputerTool.toAction(input({ action: "key", keys: '["enter"]' }))).toEqual({
      kind: "key",
      keys: "enter",
    })
    expect(ComputerTool.toAction(input({ action: "type_submit", text: "https://example.test" }))).toEqual({
      kind: "type_submit",
      text: "https://example.test",
    })
    expect(ComputerTool.toAction(input({ action: "type", text: "https://example.test", submit: true }))).toEqual({
      kind: "type_submit",
      text: "https://example.test",
    })
    expect(ComputerTool.toAction(input({ action: "copy_text" }))).toEqual({ kind: "copy_text" })
  })

  test("every declared action maps to something — no silent hole in the switch", () => {
    for (const action of ["screenshot", "move", "mouse_move", "click", "left_click", "right_click", "double_click", "doubleClick", "type", "key", "keypress", "keyDown", "press_key", "press", "key_sequence", "scroll", "cursor"] as const) {
      const result = ComputerTool.toAction(input({ action, x: 1, y: 2, text: "t", keys: "Return", direction: "up" }))
      expect("error" in result).toBe(false)
    }
  })

  test("bind is explicitly owned by the human-selection controller", () => {
    expect(ComputerTool.toAction(input({ action: "bind", display: ":0" }))).toEqual({
      error: "bind is handled by the human-selection controller",
    })
  })
})

describe("captured pixels become attempt evidence", () => {
  test("hashes the actual bytes and records a clipped crop's decoded extent", () => {
    expect(
      ComputerTool.observationOfCapture({
        handle: "/tmp/frame.png",
        bytes: Buffer.from("frame"),
        capturedAt: 123.9,
        dimensions: { width: 80, height: 40 },
        requestedRegion: { x: 1200, y: 760, width: 400, height: 400 },
      }),
    ).toEqual({
      handle: "/tmp/frame.png",
      capturedAt: 123,
      digest: "9dff50df08c635815f4b19da10f756605a34a79a48d4ba48712782502975a70e",
      region: { x: 1200, y: 760, width: 80, height: 40 },
    })
  })

  test("represents a whole-display capture without inventing viewport dimensions", () => {
    expect(
      ComputerTool.observationOfCapture({
        handle: "/tmp/frame.png",
        bytes: Buffer.from("frame"),
        capturedAt: 1,
        dimensions: { width: 1280, height: 800 },
      }).region,
    ).toBeNull()
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
    expect(ComputerTool.UNCONFIGURED).toContain("control_binding")
    expect(ComputerTool.UNCONFIGURED).toContain("computer.display")
    expect(ComputerTool.UNCONFIGURED).toContain("process environment")
  })

  test("session and ancestor bindings outrank the instance default", () => {
    const root = ComputerControlTarget.encodeWindow({
      display: ":0",
      windowID: "8388611",
      processID: 83,
      wmClass: "Chromium",
    })
    const override = ComputerControlTarget.encodeWindow({
      display: ":1",
      windowID: "4194307",
      processID: 91,
      wmClass: "Firefox",
    })
    const sessions: Record<string, SessionLike> = {
      ses_root: { id: "ses_root", controlBinding: root },
      ses_child: { id: "ses_child", parentID: "ses_root" },
      ses_override: { id: "ses_override", parentID: "ses_root", controlBinding: override },
      ses_sandbox: { id: "ses_sandbox", controlBinding: ComputerControlTarget.encodeSandbox(":98") },
      ses_bare: { id: "ses_bare" },
    }
    const resolved = (id: string, instanceDisplay: string | undefined) =>
      Effect.runSync(
        ComputerTool.resolveControlTarget(SessionSchema.ID.make(id), instanceDisplay, (key) =>
          Effect.succeed(sessions[String(key)]),
        ),
      )
    expect(resolved("ses_child", ":99")).toEqual(ComputerControlTarget.parse(root))
    expect(resolved("ses_override", ":99")).toEqual(ComputerControlTarget.parse(override))
    expect(resolved("ses_sandbox", ":99")).toEqual({
      ok: true,
      target: { kind: "sandbox-x11", display: ":98" },
    })
    expect(resolved("ses_bare", ":99")).toEqual({
      ok: true,
      target: { kind: "sandbox-x11", display: ":99" },
    })
    expect(resolved("ses_bare", undefined)).toBeUndefined()
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 🔴 THE SCREENSHOT'S PIXELS REACH THE MODEL IN ONE STEP — and the ways that silently stops being
// true are what this section pins (ruling 1: an invariant whose violation compiles green).
//
// Before this landed, `toModelOutput` was `[{type:"text", text: output.detail}]` for every action,
// so `screenshot` reported a PATH and the model needed a SECOND tool call (`read`) to see anything.
// On our own wire that second call measured 12,945 prompt tokens and ~2.1–2.4 s, against ~1,052 for
// the image itself — paid per step of P3's observe→plan→act loop.
//
// Three regressions compile green and none of them fails anywhere else in the tree:
//   1. `toModelOutput` reverts to text-only → the model silently goes blind again;
//   2. the `structured` pair is dropped → the base64 is persisted, streamed and error-lowered a
//      SECOND time as JSON, outside the media gate (this is exactly `read`'s known leak, which
//      `test/tool-result-media-gate.test.ts` has to work around);
//   3. the file part stops being the shape `gateToolMedia` consumes → a model without vision gets
//      raw bytes or a provider error instead of an honest notice (ruling 2).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const PIXELS = "aXRpc2FzY3JlZW5zaG90"

const screenshotOutput = (over: Record<string, unknown> = {}) =>
  ({
    action: "screenshot",
    ok: true,
    detail: "screenshot attached below — look at the image in this result",
    screenshotPath: "/tmp/novaclaw-computer.png",
    image: { data: PIXELS, mime: "image/png" },
    ...over,
  }) as Parameters<typeof ComputerTool.toModelContent>[0]

describe("a screenshot returns its pixels, not just a path", () => {
  test("🔴 the model gets the image ALONGSIDE the detail, in one result", () => {
    expect(ComputerTool.toModelContent(screenshotOutput())).toEqual([
      { type: "text", text: "screenshot attached below — look at the image in this result" },
      { type: "file", data: PIXELS, mime: "image/png", name: "/tmp/novaclaw-computer.png" },
    ])
  })

  test("the file part is the shape `Tool.make` settles into a ToolFileContent — data, not a uri", () => {
    // A core tool authors base64 `data`; settlement builds the `data:` URI. Emitting `uri` here
    // produces `data:image/png;base64,data:image/png;base64,…` — measured, not supposed.
    const file = ComputerTool.toModelContent(screenshotOutput())[1]!
    expect(file.type).toBe("file")
    expect("uri" in file).toBe(false)
    if (file.type === "file") expect(file.data).toBe(PIXELS)
  })

  test("NEGATIVE CONTROL: the other seven actions carry no image and lower exactly as before", () => {
    // The decision is CONDITIONAL ON THE ACTION. `move`/`click`/`type`/… produce no capture, so
    // `image` is absent and they pay nothing — which is what makes always-on affordable.
    const moved = ComputerTool.toModelContent({
      action: "move",
      ok: true,
      detail: "move done",
    } as Parameters<typeof ComputerTool.toModelContent>[0])
    expect(moved).toEqual([{ type: "text", text: "move done" }])
  })

  test("a capture that could not be attached lowers as text only — never a fabricated file part", () => {
    // `readCapture` swallows its own failures into a note on `detail`; the projection must then
    // emit no file part at all rather than an empty one.
    expect(ComputerTool.toModelContent(screenshotOutput({ image: undefined }))).toEqual([
      { type: "text", text: "screenshot attached below — look at the image in this result" },
    ])
  })
})

describe("the pixels travel ONE way — never a second copy through `structured`", () => {
  test("🔴 the structured value carries the observation and NOT the bytes", () => {
    const structured = ComputerTool.toStructured(screenshotOutput())
    expect(structured).toEqual({
      action: "screenshot",
      ok: true,
      detail: "screenshot attached below — look at the image in this result",
      screenshotPath: "/tmp/novaclaw-computer.png",
    })
    expect(JSON.stringify(structured)).not.toContain(PIXELS)
    // NEGATIVE CONTROL for the trap itself: prove the OUTPUT really does carry the bytes, so the
    // assertion above is not green merely because there was nothing to leak.
    expect(JSON.stringify(screenshotOutput())).toContain(PIXELS)
  })

  test("the tool WIRES both projections — dropping either compiles green and is invisible", () => {
    // A source ratchet rather than a behaviour test, because `Tool.make`'s config is not reachable
    // from outside: `toModelOutput`/`toStructuredOutput` live inside the registration closure. The
    // functions above can stay perfect while the tool stops calling them.
    const source = readFileSync(path.join(import.meta.dir, "computer.ts"), "utf8")
    expect(source.length).toBeGreaterThan(5_000)
    expect(source).toContain("toModelOutput: ({ output }) => toModelContent(output)")
    expect(source).toContain("toStructuredOutput: ({ output }) => toStructured(output)")
    expect(source).toContain("structured: StructuredOutput")
    expect(source).toContain("SessionExecutionAttempt.currentFence()")
    expect(source).toContain('kind: "observation"')
    expect(source).toContain("value: capture.observation")
  })
})

// ─── the seam: settled content → lowering → the wire ─────────────────────────────────────────────

const created = DateTime.makeUnsafe(0)
const model = Model.make({ id: "model", provider: "provider", route: OpenAIChat.route })
const VISION: InputCapabilities = { input: ["text", "image"] }
const TEXT_ONLY: InputCapabilities = { input: ["text"] }

/** The Content → wire-part conversion `Tool.make`'s settlement performs, applied verbatim. */
const settled = (content: ReadonlyArray<Tool.Content>): ToolContent[] =>
  content.map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : { type: "file" as const, uri: `data:${part.mime};base64,${part.data}`, mime: part.mime, name: part.name },
  )

const loweredComputerResult = (capabilities: InputCapabilities) => {
  const message = SessionMessage.Assistant.make({
    id: SessionMessage.ID.make("msg_assistant"),
    type: "assistant",
    agent: "build",
    model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    content: [
      SessionMessage.AssistantTool.make({
        type: "tool",
        id: "call_1",
        name: ComputerTool.name,
        state: SessionMessage.ToolStateCompleted.make({
          status: "completed",
          input: { action: "screenshot" },
          content: settled(ComputerTool.toModelContent(screenshotOutput())),
          structured: ComputerTool.toStructured(screenshotOutput()) as unknown as Record<string, unknown>,
        }),
        time: { created, completed: created },
      }),
    ],
    time: { created, completed: created },
  })
  const parts = toLLMMessages([message], model, capabilities).flatMap((entry) =>
    typeof entry.content === "string"
      ? []
      : (entry.content as ReadonlyArray<{ readonly type: string; readonly result?: unknown }>),
  )
  const result = parts.find((entry) => entry.type === "tool-result")!.result as {
    readonly type: string
    readonly value: unknown
  }
  return result
}

describe("end to end: the capture reaches the wire as a MEDIA part, framed and gated", () => {
  test("🔴 a vision model receives the pixels, with the untrusted-media frame in front of them", () => {
    const result = loweredComputerResult(VISION)
    expect(result.type).toBe("content")
    const parts = result.value as ReadonlyArray<ToolContent>
    expect(parts.map((part) => part.type)).toEqual(["text", "text", "file"])
    // The frame is what makes screen pixels safe to look at — it is the ONLY thing standing between
    // instruction-shaped text painted onto a screen and a model that reads it as an instruction.
    expect(parts[1]).toEqual({
      type: "text",
      text: SessionOrigin.externalMediaFrame("image", "the computer tool"),
    })
    expect(JSON.stringify(parts[2])).toContain(`data:image/png;base64,${PIXELS}`)
  })

  test("🔴 NEGATIVE CONTROL: a model without vision gets an honest notice, not bytes and not a crash", () => {
    // Ruling 2. `gateToolMedia` REPLACES the part rather than deleting it, and because `structured`
    // does not carry the bytes either, there is nothing left to leak through the JSON fallback.
    const rendered = JSON.stringify(loweredComputerResult(TEXT_ONLY))
    expect(rendered).not.toContain(PIXELS)
    expect(rendered).toContain("NOT sent")
    expect(rendered).toContain(ComputerTool.name)
  })
})
