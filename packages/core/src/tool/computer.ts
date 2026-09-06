export * as ComputerTool from "./computer"

import { ToolFailure } from "@novaclaw/llm"
import { ChildProcess } from "effect/unstable/process"
import { Effect, Layer, Schema } from "effect"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import { makeLocationNode } from "../effect/app-node"
import { Config } from "../config"
import { ConfigComputer } from "../config/computer"
import { ComputerActions } from "../computer/actions"
import { ComputerCoordinates } from "../computer/coordinates"
import { ComputerControlTarget } from "../computer/control-target"
import { WindowsComputer } from "../computer/windows-native"
import { HostExec } from "../host-exec"
import { Image } from "../image"
import { Location } from "../location"
import { Offline } from "../offline"
import { AppProcess } from "../process"
import { PermissionV2 } from "../permission"
import { EFFECTIVE_CONFIG_DEFAULTS, resolveSessionConfig, type SessionLike } from "../session/config-resolve"
import { SessionComponentRegistry } from "../session/component-registry"
import { SessionExecutionAttempt } from "../session/execution-attempt"
import { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "computer"

export const description = `Observe and control a graphical desktop: bind, screenshot, move, click, type, key, scroll, copy text.

Preferred keyboard call: {"action":"key","keys":"ctrl+o"}. Nova also normalizes the common Computer Use forms {"action":"keypress","keys":["CTRL","O"]} and {"action":"keyDown","buttons":["ctrl","o"]}.

For tasks with no API and no text interface — a native app, a game, a site that will not work headlessly. Prefer a dedicated tool when one exists; this is the slow fallback.

\`bind\` is the ONLY real-desktop entry. On Windows, give the approved executable basename in \`app\` (for example \`dosbox-x.exe\`); Nova finds exactly one visible top-level window and binds its HWND/PID/executable identity. On X11, approval gives the human 60 seconds to click one window on \`display\`. Later calls can see and address only that exact application window; ordinary actions use the durable grant.

\`screenshot\` returns the captured image in its own result — look at it directly; do not call \`read\` on the path.

On Windows, x/y use the vision model's 0–1000 logical grid from top-left to bottom-right, independent of window size. X11 uses screenshot pixels. Screenshot first and read the target off it; never reuse a position from before an action, because what you clicked may have moved it.

On an approved Windows application, \`copy_text\` atomically selects all, copies, and returns text from that exact foreground window. It never reads old clipboard contents. Use it for a long browser article after a screenshot proves the correct page is open.

⚠️ Verify by looking: a click that lands on nothing still reports success, so the only evidence it worked is the screen changing.`

export const Input = Schema.Struct({
  action: Schema.Literals([
    "bind",
    "screenshot",
    "move",
    "mouse_move",
    "click",
    "click_element",
    "left_click",
    "right_click",
    "double_click",
    "doubleClick",
    "type",
    "type_submit",
    "key",
    "keypress",
    "keyDown",
    "press_key",
    "press",
    "key_sequence",
    "scroll",
    "scroll_down",
    "copy_text",
    "cursor",
  ]).annotate({ description: "What to do." }),
  display: Schema.String.pipe(Schema.optional).annotate({
    description:
      'X11 display used only by `bind`, e.g. ":0". Approval plus the user clicking a window creates the scoped grant.',
  }),
  app: Schema.String.pipe(Schema.optional).annotate({
    description: 'Windows executable basename used only by `bind`, e.g. "dosbox-x.exe" or "chrome.exe".',
  }),
  x: Schema.Union([Schema.Finite, Schema.FiniteFromString]).pipe(Schema.optional).annotate({
    description: "Target X (Windows: 0–1000 grid; X11: pixels). Numeric strings are tolerated.",
  }),
  y: Schema.Union([Schema.Finite, Schema.FiniteFromString]).pipe(Schema.optional).annotate({
    description: "Target Y (Windows: 0–1000 grid; X11: pixels). Numeric strings are tolerated.",
  }),
  button: Schema.String.pipe(Schema.optional).annotate({
    description: 'Mouse button for `click` ("left", "middle", or "right"). Defaults to left.',
  }),
  double: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Compatibility flag: `click` with true is a double-click; prefer action `double_click`.",
  }),
  text: Schema.String.pipe(Schema.optional).annotate({ description: "Literal text for `type`." }),
  submit: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Compatibility flag: type text, then press Enter; prefer action type_submit.",
  }),
  keys: Schema.Union([Schema.String, Schema.Array(Schema.String)])
    .pipe(Schema.optional)
    .annotate({
      description: 'Key combination for `key`: preferably "ctrl+s"; ["CTRL","S"] is also accepted.',
    }),
  buttons: Schema.Array(Schema.String).pipe(Schema.optional).annotate({
    description: "Compatibility alias for a keyboard key array; prefer `keys`.",
  }),
  key: Schema.String.pipe(Schema.optional).annotate({
    description: "Compatibility alias for one keyboard key; prefer `keys`.",
  }),
  direction: Schema.Union([Schema.Literals(["up", "down", "left", "right"]), Schema.Finite, Schema.FiniteFromString])
    .pipe(Schema.optional)
    .annotate({
      description: "Scroll direction.",
    }),
  amount: Schema.Union([Schema.Finite, Schema.FiniteFromString]).pipe(Schema.optional).annotate({
    description: "Scroll clicks (1-25); larger pixel-style values are normalized safely.",
  }),
  height: Schema.Union([Schema.Finite, Schema.FiniteFromString]).pipe(Schema.optional).annotate({
    description: "Compatibility alias for a pixel-style scroll distance; prefer amount.",
  }),
  delta_y: Schema.Union([Schema.Finite, Schema.FiniteFromString]).pipe(Schema.optional).annotate({
    description: "Compatibility vertical wheel delta; Holo's measured negative value means down.",
  }),
  speed: Schema.Union([Schema.Finite, Schema.FiniteFromString]).pipe(Schema.optional).annotate({
    description: "Compatibility alias for vertical wheel delta; prefer direction plus amount.",
  }),
  /**
   * ⚠️ **One string, not four numbers and not a nested object — and the reason is MEASURED.**
   *
   * The obvious shape is a nested `{x, y, width, height}`, which has the property that matters: a
   * model cannot fill three fields and leave a half-built rectangle. It was written that way first,
   * and then weighed: the nested subtree serialises to **965 bytes**, 40% of this tool's entire input
   * schema, of which only 236 is the description — the rest is object boilerplate. That is paid on
   * every turn of every session, resident, for a field only `screenshot` reads. It tripped the 32 KB
   * resident-tool budget in `test/location-layer.test.ts` the moment it landed.
   *
   * `"x,y,width,height"` keeps the property — a partial rectangle cannot be written in this form, it
   * either parses to four integers or it is rejected by name — at a fraction of the size, and it is
   * literally what `scrot -a` takes, so the mapping is one split. Parsing is in `toAction`; the range
   * and integer rules stay in `ComputerActions`, which is the one place that knows the tool.
   */
  region: Schema.String.pipe(Schema.optional).annotate({
    description:
      'Optional crop for `screenshot`, as "x,y,width,height" in screen pixels (e.g. "100,120,240,180"). ' +
      "Use it when part of the screen animates on its own — an attract loop, a video, a clock — so a " +
      "whole-screen capture cannot tell you whether YOUR action changed anything.",
  }),
}).annotate({ identifier: "ComputerTool.Input" })

/** The captured pixels, base64, exactly as they will be handed to `Tool.Content`'s file part. */
const CapturedImage = Schema.Struct({
  data: Schema.String,
  mime: Schema.String,
}).annotate({ identifier: "ComputerTool.CapturedImage" })

const Output = Schema.Struct({
  action: Schema.String,
  ok: Schema.Boolean,
  detail: Schema.String,
  screenshotPath: Schema.String.pipe(Schema.optional),
  image: CapturedImage.pipe(Schema.optional),
})

/**
 * What is PERSISTED and streamed to the UI — deliberately the output MINUS the pixels.
 *
 * ⚠️ **`structured` is a second copy of everything it holds.** `Tool.make` defaults `structured` to
 * the encoded output, and `read.ts` takes that default — which is why `tool-result-media-gate.test.ts`
 * has to prove that BLOCKING an image does not re-ship it as JSON from `structured`. The base64 there
 * is stored in the session record, re-encoded on every SSE frame, and lowered as text on the error
 * arm. A screenshot loop pays that per step, so `computer` declares a structured shape that simply
 * does not contain the bytes: they travel exactly one way, as the file part below, through the ONE
 * media gate. Stated as a test in `computer.test.ts` because dropping this pair compiles green.
 */
const StructuredOutput = Schema.Struct({
  action: Schema.String,
  ok: Schema.Boolean,
  detail: Schema.String,
  screenshotPath: Schema.String.pipe(Schema.optional),
})

type OutputEncoded = (typeof Output)["Encoded"]

export const toStructured = (output: OutputEncoded): (typeof StructuredOutput)["Type"] => ({
  action: output.action,
  ok: output.ok,
  detail: output.detail,
  ...(output.screenshotPath === undefined ? {} : { screenshotPath: output.screenshotPath }),
})

/**
 * 🔴 **THE SCREENSHOT'S PIXELS RIDE THE RESULT — always, for `screenshot`, and never for anything
 * else. This is the decision; the reasoning is here because the P3 loop is budgeted against it.**
 *
 * Before this, `toModelOutput` was `[{type:"text", text: output.detail}]` for every action, so a
 * `screenshot` returned a PATH and the model needed a **second** tool call (`read`) to see anything.
 * Measured cost of that second call on our own wire: **12,945 prompt tokens** for the request
 * (system prompt + tools + agent scaffolding) plus **~2.1–2.4 s**, against ~1,052 prompt tokens for
 * the image itself. P3 observes once per step, so the extra round-trip is ~10× the thing it fetches,
 * every step, forever.
 *
 * **Why not opt-in via an input field.** An opt-in recreates exactly that cost and does it
 * *silently*: a model that forgets the flag gets a path, and the failure looks like the tool working.
 * The whole purpose of `screenshot` is to be looked at.
 *
 * **Why not a model-facing opt-out either.** The one caller that wants a capture without pixels is
 * the verifier — but `computer/verify.ts` decides on DIGESTS the harness computes, not on pixels the
 * model reads, so it does not come through this projection at all. A knob with no consumer is
 * schema bytes on a deferred tool plus a way for the model to blind itself. The lever that DOES
 * exist is `region`: a crop is smaller in bytes, in image tokens and in ambiguity, and it is already
 * the answer to "I do not need the whole screen".
 *
 * **Conditional on the action, which costs the other seven nothing.** `move` · `click` ·
 * `double_click` · `type` · `key` · `scroll` · `cursor` produce no image, so `output.image` is
 * absent and they lower exactly as before — one text part.
 *
 * ⚠️ **THE COST P3's AUTHOR MUST BUDGET, stated here rather than left to be discovered: history
 * ACCUMULATES.** One screenshot is ~1,000–1,500 image tokens at 1280×800, but a settled tool result
 * is durable — an N-step loop re-sends N screenshots on step N+1, so the context grows
 * quadratically in steps while each individual result looks cheap. Lowering cannot fix that (by the
 * time bytes arrive here the tool has already run); the loop must prune or compact its own stale
 * observations, or run in a narrow session.
 *
 * The file part is the shape `gateToolMedia` consumes (`session/runner/to-llm-message.ts`), which is
 * what makes this honest on a model without vision: the bytes are REPLACED by a notice naming the
 * tool rather than dropped or sent to fail at the provider (ruling 2).
 *
 * ⭐ **Verified on the wire, not by unit test alone (2026-08-07).** An isolated instance against
 * `spark-holo/holo3.1` through a logging proxy: the third outbound request carried
 * `{"type":"image_url","image_url":{"url":"data:image/png;base64,…"}}` with the capture's exact
 * bytes, preceded by the media frame, and the model read words that exist only inside the pixels.
 * Same run with the model's declared `input` set to `["text"]`: zero bytes on the wire, the
 * `NOT sent to you` notice in their place, and the model said it could not see rather than guessing.
 */
export const toModelContent = (output: OutputEncoded): ReadonlyArray<Tool.Content> =>
  output.image === undefined
    ? [{ type: "text", text: output.detail }]
    : [
        { type: "text", text: output.detail },
        {
          type: "file",
          data: output.image.data,
          mime: output.image.mime,
          ...(output.screenshotPath === undefined ? {} : { name: output.screenshotPath }),
        },
      ]

/**
 * `"x,y,width,height"` → a region, or a refusal that says what was wrong.
 *
 * ⚠️ **Four parts exactly, and every part a number — no defaulting a missing one.** A region with an
 * assumed width is a wrong crop that reports success, and every coordinate read off the resulting
 * image is then offset with nothing in the picture to say so. The integer and range rules are NOT
 * repeated here; `ComputerActions.build` owns them, because it is the module that knows what `scrot`
 * accepts and duplicating the rule is how the two drift apart.
 */
export const parseRegion = (raw: string): ComputerActions.Region | { readonly error: string } => {
  const parts = raw.split(",").map((part) => part.trim())
  if (parts.length !== 4) return { error: `region must be "x,y,width,height" — got ${parts.length} value(s): ${raw}` }
  const [x, y, width, height] = parts.map(Number)
  for (const [name, value] of [
    ["x", x],
    ["y", y],
    ["width", width],
    ["height", height],
  ] as const)
    if (value === undefined || !Number.isFinite(value)) return { error: `region ${name} is not a number: ${raw}` }
  return { x: x!, y: y!, width: width!, height: height! }
}

/**
 * Turn the model's flat input into the action union. Kept separate from `build` so the schema can
 * stay flat — a model fills a flat object far more reliably than a discriminated union, and the
 * cost is this one translation.
 */
export const toAction = (input: Input): ComputerActions.Action | { readonly error: string } => {
  const point = () => (input.x === undefined || input.y === undefined ? undefined : { x: input.x, y: input.y })
  switch (input.action) {
    case "bind":
      return { error: "bind is handled by the human-selection controller" }
    case "screenshot": {
      if (input.region === undefined) return { kind: "screenshot" }
      const region = parseRegion(input.region)
      return "error" in region ? region : { kind: "screenshot", region }
    }
    case "cursor":
      return { kind: "cursor" }
    case "copy_text":
      return { kind: "copy_text" }
    case "move":
    case "mouse_move": {
      const p = point()
      return p ? { kind: "move", point: p } : { error: "move needs both x and y" }
    }
    case "click":
    case "click_element":
    case "left_click":
    case "right_click": {
      const p = point()
      const button = input.action === "right_click" ? "right" : (input.button ?? "left")
      if (button !== "left" && button !== "middle" && button !== "right")
        return { error: `click button must be left, middle, or right — got ${button}` }
      if (input.double === true) {
        if (button !== "left") return { error: "double-click supports only the left button" }
        return { kind: "double_click", ...(p ? { point: p } : {}) }
      }
      return { kind: "click", button, ...(p ? { point: p } : {}) }
    }
    case "double_click":
    case "doubleClick": {
      const p = point()
      return { kind: "double_click", ...(p ? { point: p } : {}) }
    }
    case "type":
    case "type_submit":
      return input.text === undefined
        ? { error: `${input.action} needs text` }
        : input.action === "type_submit" || input.submit === true
          ? { kind: "type_submit", text: input.text }
          : { kind: "type", text: input.text }
    case "key":
    case "keypress":
    case "keyDown":
    case "press_key":
    case "press":
    case "key_sequence": {
      const raw = input.keys ?? input.buttons ?? input.key ?? input.button
      if (raw === undefined) return { error: "key needs keys" }
      let normalized = raw
      if (typeof raw === "string" && /^\s*\[/.test(raw)) {
        try {
          const parsed: unknown = JSON.parse(raw)
          if (Array.isArray(parsed) && parsed.every((part) => typeof part === "string")) normalized = parsed
        } catch {}
      }
      const keys = typeof normalized === "string" ? normalized.trim().replace(/\s+/g, "+") : normalized.join("+")
      return keys === "" ? { error: "key needs keys" } : { kind: "key", keys }
    }
    case "scroll":
    case "scroll_down": {
      const delta = typeof input.direction === "number" ? input.direction : (input.delta_y ?? input.speed)
      const direction =
        input.action === "scroll_down"
          ? "down"
          : typeof input.direction === "string"
            ? input.direction
            : delta === undefined || delta === 0
              ? undefined
              : delta < 0
                ? "down"
                : "up"
      if (direction === undefined) return { error: "scroll needs a direction or non-zero delta_y" }
      const raw = Math.abs(input.amount ?? input.height ?? delta ?? 3)
      // Holo emitted amount/height=800 and delta_y=-200 for an ordinary page scroll. Treating those
      // as wheel-click counts either trips the safety bound or would fling the page; they are pixel
      // dialects, so normalize at roughly one wheel notch per 120 px and retain the hard 25-click cap.
      const amount = raw > 25 ? Math.min(25, Math.max(1, Math.round(raw / 120))) : Math.round(raw)
      return { kind: "scroll", direction, amount }
    }
  }
}

export interface Input extends Schema.Schema.Type<typeof Input> {}

/**
 * The message when no display is configured.
 *
 * ⚠️ Ruling 2 — an unavailable subsystem NAMES ITSELF rather than rendering empty. Unconfigured is
 * the COMMON case (a Windows laptop, a headless server), so this path is the one most callers meet,
 * and it has to say what to set. The knob is runtime-editable per the self-healing law, so an agent
 * that reads this can repair it with one `PATCH /config` — which is the whole point of naming it.
 */
export const UNCONFIGURED =
  "No display is configured for computer use, so there is nothing to observe or click. " +
  "Set `computer.display` as the instance's SANDBOX default. A real desktop never uses that default: " +
  "it needs a human-granted, app-specific `control_binding` component. A display is never inherited " +
  "from the process environment: that would " +
  "either fail on a headless host or " +
  "silently drive the operator's real screen."

/** Resolve a tagged session grant first; the instance display is an explicitly sandbox-only default. */
export const resolveControlTarget = <E, R>(
  sessionID: SessionSchema.ID,
  instanceDisplay: string | undefined,
  getSession: (id: SessionSchema.ID) => Effect.Effect<SessionLike | undefined, E, R>,
): Effect.Effect<ComputerControlTarget.Parsed | undefined, E, R> =>
  resolveSessionConfig(EFFECTIVE_CONFIG_DEFAULTS, sessionID, (id) => getSession(SessionSchema.ID.make(id))).pipe(
    Effect.map((resolved) =>
      resolved.controlBinding !== undefined
        ? ComputerControlTarget.parse(resolved.controlBinding)
        : instanceDisplay === undefined
          ? undefined
          : { ok: true, target: ComputerControlTarget.sandbox(instanceDisplay) },
    ),
  )

/**
 * The MIME of the file `scrot` just wrote, read off the configured path's extension.
 *
 * `scrot` picks its output format from the extension, so the extension is the only fact we have —
 * and it is a real one, not a guess: the path is the operator's own `computer.screenshotPath`, and
 * the same string is what `scrot` was handed. JPEG is the default because full-window browser
 * observations otherwise turn into very large durable base64 payloads, and because a wrong MIME here is not
 * cosmetic — `attachmentModality` maps it onto the model's declared input modalities, so an
 * unrecognised type would make the capability gate answer `unknown` instead of `image`.
 */
const captureMime = (screenshotPath: string): string => {
  const extension = screenshotPath.slice(screenshotPath.lastIndexOf(".") + 1).toLowerCase()
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg"
  if (extension === "webp") return "image/webp"
  if (extension === "gif") return "image/gif"
  return "image/png"
}

export const observationOfCapture = (input: {
  readonly handle: string
  readonly bytes: Uint8Array
  readonly capturedAt: number
  readonly dimensions: { readonly width: number; readonly height: number }
  readonly requestedRegion?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
}): SessionComponentRegistry.Observation => ({
  handle: input.handle,
  capturedAt: Math.max(0, Math.floor(input.capturedAt)),
  digest: createHash("sha256").update(input.bytes).digest("hex"),
  region: input.requestedRegion
    ? {
        x: input.requestedRegion.x,
        y: input.requestedRegion.y,
        // `scrot` clips at the display edge. The decoded file is the authority for the covered extent.
        width: input.dimensions.width,
        height: input.dimensions.height,
      }
    : null,
})

/**
 * Read the capture back and prepare it for the result — or say, in words, why it is not there.
 *
 * ⚠️ **This never fails the tool.** The capture itself succeeded (`scrot` exited 0 and the actions
 * layer already refused a bad region), so a file that cannot be read or attached is a degraded
 * observation, not a failed action. Ruling 2 forbids the two easy wrong answers: pretending an image
 * is there, and reporting the whole action as a failure the model should retry. It returns a note
 * instead, which is appended to the same `detail` the model reads.
 *
 * 🔴 **Size is handled by the ONE image seam (`Image.normalize`), and the OUTCOME IS ANNOUNCED.**
 * `read.ts` normalizes exactly these bytes, so a second size policy here would be the duplication
 * ruling 6 exists to prevent. But a resize is a COORDINATE TRANSFORM, and this is the one tool where
 * that is semantic rather than cosmetic: `computer/coordinates.ts` supports a `pixels` space, and a
 * grounder that emits pixels off a silently downscaled frame misses every target while staying
 * on-screen — precisely the failure mode `sniffSpace` is documented as unable to catch. So the
 * common case (a substrate display within the limits) returns the bytes IDENTICALLY, and the
 * downscaled case says so in the result rather than letting the model assume 1:1.
 */
const readCapture = (
  images: Image.Interface,
  screenshotPath: string,
  requestedRegion?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): Effect.Effect<{
  readonly image?: { readonly data: string; readonly mime: string }
  readonly observation?: SessionComponentRegistry.Observation
  readonly note?: string
}> =>
  Effect.gen(function* () {
    const captured = yield* Effect.tryPromise({
      try: async () => {
        const file = await fs.open(screenshotPath, "r")
        try {
          const [bytes, stat] = await Promise.all([file.readFile(), file.stat()])
          return { bytes, capturedAt: stat.mtimeMs }
        } finally {
          await file.close()
        }
      },
      catch: (error) => error,
    })
    const content = {
      uri: `file://${screenshotPath}`,
      name: screenshotPath,
      content: captured.bytes.toString("base64"),
      encoding: "base64" as const,
      mime: captureMime(screenshotPath),
    }
    const dimensions = yield* images
      .inspect(screenshotPath, content)
      .pipe(Effect.catch(() => Effect.succeed(undefined)))
    const observation = dimensions
      ? observationOfCapture({
          handle: screenshotPath,
          bytes: captured.bytes,
          capturedAt: captured.capturedAt,
          dimensions,
          ...(requestedRegion === undefined ? {} : { requestedRegion }),
        })
      : undefined
    // Same fallback `read.ts` takes: no resizer (the wasm decoder failed to load) is not a reason to
    // withhold a capture that is almost certainly within limits anyway.
    const normalizedResult = yield* images.normalize(screenshotPath, content).pipe(
      Effect.catchTag("Image.ResizerUnavailableError", () => Effect.succeed(content)),
      Effect.match({ onFailure: (error) => ({ error }), onSuccess: (normalized) => ({ normalized }) }),
    )
    if ("error" in normalizedResult)
      return {
        ...(observation === undefined ? {} : { observation }),
        note:
          ` ⚠️ The image could NOT be attached to this result (${String(normalizedResult.error)}), so you have not seen ` +
          "it — say so rather than describing the screen. Capture a smaller `region` and try again.",
      }
    const normalized = normalizedResult.normalized
    const metadataNote =
      observation === undefined
        ? " ⚠️ The frame was returned but its dimensions could not be decoded, so no current observation component was recorded."
        : ""
    if (normalized.content === content.content)
      return {
        image: { data: content.content, mime: content.mime },
        ...(observation === undefined ? {} : { observation }),
        ...(metadataNote ? { note: metadataNote } : {}),
      }
    return {
      image: { data: normalized.content, mime: normalized.mime },
      ...(observation === undefined ? {} : { observation }),
      note:
        " ⚠️ The attached image was DOWNSCALED to fit attachment limits, so its pixels are NOT 1:1 " +
        "with screen pixels: give targets in normalized coordinates, or capture a `region` of the " +
        `screen instead of the whole thing.${metadataNote}`,
    }
  }).pipe(
    Effect.catch((error: unknown) =>
      Effect.succeed({
        note:
          ` ⚠️ The image could NOT be attached to this result (${String(error)}), so you have not seen ` +
          "it — say so rather than describing the screen. Capture a smaller `region` and try again.",
      }),
    ),
  )

export const metadata = {
  sideEffect: "non-idempotent",
  description,
  input: Input,
  output: Output,
  structured: StructuredOutput,
} as const

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const config = yield* Config.Service
    const permission = yield* PermissionV2.Service
    const processes = yield* AppProcess.Service
    const location = yield* Location.Service
    const images = yield* Image.Service
    const sessions = yield* SessionStore.Service
    const components = yield* SessionComponentRegistry.Service
    const offline = yield* Offline.Service

    yield* tools
      .register({
        /**
         * 🔴 **DEFERRED, and the region field is what forced the question rather than what answered
         * it.** This tool was resident — its schema in every request of every session — and adding
         * `region` tripped the 32 KB resident-tool budget in `test/location-layer.test.ts`. The cheap
         * response was to trim 148 bytes of description and squeak back under. The right one is that
         * `computer` never belonged in the resident set:
         *  · It is UNCONFIGURED on most machines — a Windows laptop, a headless server — where its
         *    only possible answer is the message saying so. That cost was being paid per turn to
         *    advertise a capability that could not run.
         *  · Sessions that drive a desktop are a small minority, and they are self-identifying: a task
         *    that needs a screen says so, and discovery surfaces the tool then.
         *  · It sits beside `messenger`, `kb`, `profile` and `recipe` in exactly this respect.
         *
         * Worth ~2.4 KB of every fresh request (1.8 KB of input schema plus the description), which is
         * a far larger win than the budget failure that surfaced it.
         */
        [name]: Tool.withDeferred(
          Tool.make({
            ...metadata,
            toStructuredOutput: ({ output }) => toStructured(output),
            toModelOutput: ({ output }) => toModelContent(output),
            execute: (input, context) =>
              Effect.gen(function* () {
                const runArgv = (
                  argv: ReadonlyArray<string>,
                  overlay: Readonly<Record<string, string>> = {},
                  interactive = false,
                ) => {
                  const plan = HostExec.plan({
                    shape: { kind: "argv", argv },
                    cwd: location.directory,
                    worktree: location.directory,
                    consent: "none",
                    overlay,
                  })
                  if (plan.via === "none") return Effect.fail(new ToolFailure({ message: plan.message }))
                  if (plan.via !== "exec")
                    return Effect.fail(new ToolFailure({ message: "computer: refusing a non-argv execution" }))
                  const run = processes.run(
                    ChildProcess.make(plan.file, [...plan.args], {
                      env: plan.env.vars,
                      extendEnv: plan.env.inherit,
                    }),
                  )
                  return (interactive ? run.pipe(Effect.timeout("60 seconds")) : run).pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `computer: ${plan.file} failed — ${String(error)}` }),
                    ),
                  )
                }

                const settings = Config.latest(yield* config.entries(), "computer") as ConfigComputer.Info | undefined
                if (input.action === "bind") {
                  const offlineRefusal = ComputerControlTarget.offlineRealDesktopRefusal(offline.policy.enabled)
                  if (offlineRefusal)
                    return yield* Effect.fail(
                      new ToolFailure({
                        message: `computer: ${offlineRefusal}`,
                      }),
                    )
                  if (process.platform === "win32") {
                    const executable = input.app?.trim()
                    if (!executable || !/^[^\\/:*?"<>|]+\.exe$/i.test(executable))
                      return yield* Effect.fail(
                        new ToolFailure({
                          message:
                            'computer: Windows bind needs an executable basename in `app`, for example "dosbox-x.exe"',
                        }),
                      )
                    const resource = `bind-windows-app/${encodeURIComponent(executable.toLowerCase())}`
                    yield* permission.assert({
                      action: name,
                      resources: [resource],
                      save: [resource],
                      metadata: { action: input.action, app: executable },
                      sessionID: context.sessionID,
                      source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                    })
                    const helper = yield* Effect.tryPromise({
                      try: () => WindowsComputer.ensureHelper(),
                      catch: (error) =>
                        new ToolFailure({ message: `computer: cannot prepare Windows helper — ${String(error)}` }),
                    })
                    const result = yield* runArgv(WindowsComputer.bindArgv(helper, executable), {}, true)
                    const selected = WindowsComputer.parseInspection(result.stdout.toString())
                    if (!selected)
                      return yield* Effect.fail(
                        new ToolFailure({ message: "computer: Windows returned no valid approved-window identity" }),
                      )
                    const binding = ComputerControlTarget.encodeWindowsWindow({
                      windowHandle: selected.handle,
                      processID: selected.processID,
                      executable: selected.executable,
                    })
                    yield* components.put({ sessionID: context.sessionID, kind: "control_binding", value: binding })
                    return {
                      action: input.action,
                      ok: true,
                      detail:
                        `Connected this session to the visible ${selected.executable} window only ` +
                        `(pid ${selected.processID}, HWND ${selected.handle}). Other applications and the ambient desktop remain outside scope.`,
                    }
                  }
                  const display = input.display?.trim()
                  if (!display)
                    return yield* Effect.fail(
                      new ToolFailure({
                        message: 'computer: bind needs the real desktop X11 display, for example ":0"',
                      }),
                    )
                  const resource = `bind-x11-window/${encodeURIComponent(display)}`
                  yield* permission.assert({
                    action: name,
                    resources: [resource],
                    save: [resource],
                    metadata: { action: input.action, display },
                    sessionID: context.sessionID,
                    source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                  })
                  const selection = yield* runArgv(["xdotool", "selectwindow"], { DISPLAY: display }, true)
                  const selectedWindowID = ComputerControlTarget.parseWindowID(selection.stdout.toString())
                  if (!selectedWindowID)
                    return yield* Effect.fail(
                      new ToolFailure({ message: "computer: the window selector returned no valid X11 window id" }),
                    )
                  // Window managers commonly return their decoration frame rather than the client
                  // the human clicked. Descend the authoritative X tree and accept exactly one
                  // PID+WM_CLASS client; zero or ambiguity fails closed.
                  const selectedArg = ComputerControlTarget.xWindowArg(selectedWindowID)
                  const tree = yield* runArgv(["xwininfo", "-id", selectedArg, "-tree"], { DISPLAY: display })
                  const treeText = tree.stdout.toString()
                  const clientList = yield* runArgv(
                    ["xprop", "-root", "_NET_CLIENT_LIST_STACKING", "_NET_CLIENT_LIST"],
                    { DISPLAY: display },
                  )
                  const resolvedClient = ComputerControlTarget.resolveSelectedClient(
                    selectedWindowID,
                    treeText,
                    clientList.stdout.toString(),
                  )
                  if (!resolvedClient.ok)
                    return yield* Effect.fail(
                      new ToolFailure({
                        message: `computer: ${resolvedClient.reason}`,
                      }),
                    )
                  const windowID = resolvedClient.windowID
                  const windowArg = ComputerControlTarget.xWindowArg(windowID)
                  const [pidResult, classResult] = yield* Effect.all([
                    runArgv(["xdotool", "getwindowpid", windowArg], { DISPLAY: display }),
                    runArgv(["xprop", "-id", windowArg, "WM_CLASS"], { DISPLAY: display }),
                  ])
                  const processID = ComputerControlTarget.parseWindowPID(pidResult.stdout.toString())
                  const wmClass = ComputerControlTarget.parseWmClass(classResult.stdout.toString())
                  if (processID === undefined || wmClass === undefined)
                    return yield* Effect.fail(
                      new ToolFailure({
                        message:
                          "computer: the selected application did not expose a readable PID and WM_CLASS, so it cannot be scoped safely",
                      }),
                    )
                  const binding = ComputerControlTarget.encodeWindow({ display, windowID, processID, wmClass })
                  yield* components.put({
                    sessionID: context.sessionID,
                    kind: "control_binding",
                    value: binding,
                  })
                  return {
                    action: input.action,
                    ok: true,
                    detail:
                      `Connected this session to the human-selected ${wmClass} window only ` +
                      `(pid ${processID}, window ${windowID}). Other applications and the ambient desktop remain outside scope.`,
                  }
                }
                const resolvedTarget = yield* resolveControlTarget(context.sessionID, settings?.display, sessions.get)
                if (!resolvedTarget) return yield* Effect.fail(new ToolFailure({ message: UNCONFIGURED }))
                if (!resolvedTarget.ok)
                  return yield* Effect.fail(new ToolFailure({ message: `computer: ${resolvedTarget.reason}` }))
                const target = resolvedTarget.target
                const offlineRefusal =
                  target.kind !== "sandbox-x11"
                    ? ComputerControlTarget.offlineRealDesktopRefusal(offline.policy.enabled)
                    : undefined
                if (offlineRefusal)
                  return yield* Effect.fail(
                    new ToolFailure({
                      message: `computer: ${offlineRefusal}`,
                    }),
                  )
                const screenshotPath = settings?.screenshotPath ?? ConfigComputer.DEFAULT_SCREENSHOT_PATH

                const action = toAction(input)
                if ("error" in action) return yield* Effect.fail(new ToolFailure({ message: action.error }))
                const attempt = action.kind === "screenshot" ? yield* SessionExecutionAttempt.currentFence() : undefined
                if (action.kind === "screenshot" && attempt === undefined)
                  return yield* Effect.fail(
                    new ToolFailure({
                      message: "computer: no current execution attempt is available for this capture",
                    }),
                  )

                let windowArg: string | undefined
                if (target.kind === "x11-window") {
                  windowArg = ComputerControlTarget.xWindowArg(target.windowID)
                  const [pidResult, classResult] = yield* Effect.all([
                    runArgv(["xdotool", "getwindowpid", windowArg], { DISPLAY: target.display }),
                    runArgv(["xprop", "-id", windowArg, "WM_CLASS"], { DISPLAY: target.display }),
                  ])
                  const identity = ComputerControlTarget.verifyWindowIdentity(
                    target,
                    pidResult.stdout.toString(),
                    classResult.stdout.toString(),
                  )
                  if (!identity.ok)
                    return yield* Effect.fail(
                      new ToolFailure({
                        message:
                          `computer: the human-granted ${target.wmClass} window is no longer the same application ` +
                          `(expected pid ${target.processID} / WM_CLASS ${JSON.stringify(target.wmClass)}, found ` +
                          `${identity.actualPID ?? "unreadable"} / ` +
                          `${JSON.stringify(identity.actualClass ?? "unreadable")}). ` +
                          "The grant is stale; ask the user to select the application again.",
                      }),
                    )
                }

                let windowsHelper: string | undefined
                let windowsInspection: WindowsComputer.Inspection | undefined
                if (target.kind === "windows-window") {
                  windowsHelper = yield* Effect.tryPromise({
                    try: () => WindowsComputer.ensureHelper(),
                    catch: (error) =>
                      new ToolFailure({ message: `computer: cannot prepare Windows helper — ${String(error)}` }),
                  })
                  const inspected = yield* runArgv(WindowsComputer.inspectArgv(windowsHelper, target.windowHandle))
                  const inspection = WindowsComputer.parseInspection(inspected.stdout.toString())
                  if (!inspection)
                    return yield* Effect.fail(
                      new ToolFailure({ message: "computer: the approved Windows application identity is unreadable" }),
                    )
                  const identity = WindowsComputer.verifyIdentity(target, inspection)
                  if (!identity.ok)
                    return yield* Effect.fail(
                      new ToolFailure({
                        message:
                          `computer: the approved ${target.executable} window is unavailable (${identity.reason}). ` +
                          "Bring that window to the front or bind it again; Nova will not redirect input to another application.",
                      }),
                    )
                  windowsInspection = inspection
                }

                const built =
                  target.kind === "windows-window"
                    ? WindowsComputer.build(
                        action,
                        target,
                        windowsInspection!,
                        windowsHelper!,
                        screenshotPath,
                        // DECLARED, never inferred (`computer/coordinates.ts`). The tool's own
                        // description tells the model this grid; the builder is told the same thing.
                        "normalized-1000",
                      )
                    : ComputerActions.build(action, {
                        display: target.display,
                        screenshotPath,
                        ...(windowArg === undefined ? {} : { windowID: windowArg }),
                      })
                if (!built.ok) return yield* Effect.fail(new ToolFailure({ message: built.reason }))

                // One assert for the whole tool: the resource is the ACTION, not a coordinate — a
                // permission rule a person can read ("allow computer/screenshot") and not a pixel.
                const permissionResource = ComputerControlTarget.permissionResource(target, input.action)
                yield* permission.assert({
                  action: name,
                  resources: [permissionResource],
                  save: [permissionResource],
                  metadata: { ...input, controlTarget: target },
                  sessionID: context.sessionID,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })

                // Each command goes through the ONE host-execution gate as literal argv — never a
                // shell string, because `type` carries model-authored text read off an untrusted
                // screen. `overlay` is the functional, non-secret channel the display rides.
                const outputs: string[] = []
                for (const argv of built.argv) {
                  const result = yield* runArgv(argv, built.env)
                  const text = result.stdout.toString().trim()
                  if (text) outputs.push(text)
                }

                // The pixels are read back HERE rather than in `toModelOutput`, because that projection
                // is pure and synchronous — it gets the encoded output and nothing else. So the bytes
                // have to travel on the output, and `toStructuredOutput` above is what keeps them from
                // being persisted a second time as JSON.
                const capture =
                  action.kind === "screenshot" ? yield* readCapture(images, screenshotPath, action.region) : {}
                if (capture.observation && attempt)
                  yield* components.put({
                    sessionID: context.sessionID,
                    kind: "observation",
                    value: capture.observation,
                    attempt,
                  })

                const detail =
                  action.kind === "screenshot"
                    ? // The region is named back, because the file at `screenshotPath` is a CROP and a
                      // reader who assumes a full frame will ground every coordinate off by the origin.
                      //
                      // ⚠️ The ORIGIN is stated as fact and the SIZE only as an upper bound, because
                      // `scrot` silently clips a region that overruns the screen: measured 2026-08-06,
                      // `-a 1200,760,400,400` on a 1280x800 display wrote an 80x40 file with no error.
                      // The origin survives clipping, so it stays exact; asserting the requested size
                      // would be describing the file as something it is not.
                      (target.kind !== "sandbox-x11"
                        ? `Only the approved ${target.kind === "x11-window" ? target.wmClass : target.executable} application window is attached; ` +
                          "coordinates are relative to that window. "
                        : "") +
                      (action.region
                        ? `screenshot attached below — a CROP with its origin at ` +
                          `(${action.region.x},${action.region.y}) and up to ` +
                          `${action.region.width}x${action.region.height} (clipped at the screen edge). ` +
                          `Coordinates read off it are relative to that origin: add it back before clicking. ` +
                          `Also written to ${screenshotPath}.`
                        : `screenshot attached below — look at the image in this result rather than ` +
                          `reading ${screenshotPath}, which is the same capture.`) +
                      (capture.note ?? "")
                    : outputs.length > 0
                      ? outputs.join("\n")
                      : `${input.action} done`
                return {
                  action: input.action,
                  ok: true,
                  detail,
                  ...(action.kind === "screenshot" ? { screenshotPath } : {}),
                  ...(capture.image === undefined ? {} : { image: capture.image }),
                }
              }).pipe(
                // The tool's contract is ToolFailure only. Config reads and the process runner have
                // their own error types; a leaked one becomes a defect at settlement rather than an
                // observation the model can act on.
                //
                // 🔴 1J. The fallback used to run for EVERY error, so a permission refusal reached
                // the model as `"computer: PermissionV2.DeniedError"` — the tag, not the crafted
                // deny-fast paragraph (measured 2026-09-01). `Tool.absorb` puts `denialMessage`
                // ahead of it; the `computer:` prefix still labels everything else.
                Effect.mapError(Tool.absorb((error) => `computer: ${String(error)}`)),
              ),
          }),
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/computer",
  layer,
  // `Image.node` is here for the SAME reason `tool/read.ts` has it: a tool that returns pixels
  // consults the one image seam before it does, so the size policy lives in a single place.
  deps: [
    ToolRegistry.node,
    PermissionV2.node,
    AppProcess.node,
    Location.node,
    Config.node,
    Image.node,
    SessionStore.node,
    SessionComponentRegistry.node,
    Offline.node,
  ],
})

/** Re-exported so a caller converting a grounder's output has one obvious place to look. */
export const toPixels = ComputerCoordinates.toPixels
