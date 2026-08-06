export * as ComputerTool from "./computer"

import { ToolFailure } from "@novaclaw/llm"
import { ChildProcess } from "effect/unstable/process"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Config } from "../config"
import { ConfigComputer } from "../config/computer"
import { ComputerActions } from "../computer/actions"
import { ComputerCoordinates } from "../computer/coordinates"
import { HostExec } from "../host-exec"
import { Location } from "../location"
import { AppProcess } from "../process"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "computer"

export const description = `Observe and control a graphical desktop: screenshot, move, click, type, key, scroll.

For tasks with no API and no text interface — a native app, a game, a site that will not work headlessly. Prefer a dedicated tool when one exists; this is the slow fallback.

Coordinates are SCREEN PIXELS from the top-left. Screenshot first and read the target off it; never reuse a position from before an action, because what you clicked may have moved it.

⚠️ Verify by looking: a click that lands on nothing still reports success, so the only evidence it worked is the screen changing.`

export const Input = Schema.Struct({
  action: Schema.Literals(["screenshot", "move", "click", "double_click", "type", "key", "scroll", "cursor"]).annotate(
    { description: "What to do." },
  ),
  x: Schema.Number.pipe(Schema.optional).annotate({ description: "Target X in screen pixels (move/click)." }),
  y: Schema.Number.pipe(Schema.optional).annotate({ description: "Target Y in screen pixels (move/click)." }),
  button: Schema.Literals(["left", "middle", "right"]).pipe(Schema.optional).annotate({
    description: "Mouse button for `click`. Defaults to left.",
  }),
  text: Schema.String.pipe(Schema.optional).annotate({ description: "Literal text for `type`." }),
  keys: Schema.String.pipe(Schema.optional).annotate({
    description: 'Key combination for `key`, e.g. "Return", "ctrl+s", "alt+Tab".',
  }),
  direction: Schema.Literals(["up", "down", "left", "right"]).pipe(Schema.optional).annotate({
    description: "Scroll direction.",
  }),
  amount: Schema.Number.pipe(Schema.optional).annotate({ description: "Scroll clicks (1-25)." }),
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

const Output = Schema.Struct({
  action: Schema.String,
  ok: Schema.Boolean,
  detail: Schema.String,
  screenshotPath: Schema.String.pipe(Schema.optional),
})

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
  if (parts.length !== 4)
    return { error: `region must be "x,y,width,height" — got ${parts.length} value(s): ${raw}` }
  const [x, y, width, height] = parts.map(Number)
  for (const [name, value] of [
    ["x", x],
    ["y", y],
    ["width", width],
    ["height", height],
  ] as const)
    if (value === undefined || !Number.isFinite(value))
      return { error: `region ${name} is not a number: ${raw}` }
  return { x: x!, y: y!, width: width!, height: height! }
}

/**
 * Turn the model's flat input into the action union. Kept separate from `build` so the schema can
 * stay flat — a model fills a flat object far more reliably than a discriminated union, and the
 * cost is this one translation.
 */
export const toAction = (input: Input): ComputerActions.Action | { readonly error: string } => {
  const point = () =>
    input.x === undefined || input.y === undefined ? undefined : { x: input.x, y: input.y }
  switch (input.action) {
    case "screenshot": {
      if (input.region === undefined) return { kind: "screenshot" }
      const region = parseRegion(input.region)
      return "error" in region ? region : { kind: "screenshot", region }
    }
    case "cursor":
      return { kind: "cursor" }
    case "move": {
      const p = point()
      return p ? { kind: "move", point: p } : { error: "move needs both x and y" }
    }
    case "click": {
      const p = point()
      return { kind: "click", button: input.button ?? "left", ...(p ? { point: p } : {}) }
    }
    case "double_click": {
      const p = point()
      return { kind: "double_click", ...(p ? { point: p } : {}) }
    }
    case "type":
      return input.text === undefined ? { error: "type needs text" } : { kind: "type", text: input.text }
    case "key":
      return input.keys === undefined ? { error: "key needs keys" } : { kind: "key", keys: input.keys }
    case "scroll":
      return input.direction === undefined
        ? { error: "scroll needs a direction" }
        : { kind: "scroll", direction: input.direction, amount: input.amount ?? 3 }
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
  "Set `computer.display` (for example \":99\") to the X display of a desktop this instance can reach. " +
  "A display is never inherited from the environment: that would either fail on a headless host or " +
  "silently drive the operator's real screen."

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const config = yield* Config.Service
    const permission = yield* PermissionV2.Service
    const processes = yield* AppProcess.Service
    const location = yield* Location.Service

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
        [name]: Tool.withDeferred(Tool.make({
          sideEffect: "non-idempotent",
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.detail }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const settings = Config.latest(yield* config.entries(), "computer") as ConfigComputer.Info | undefined
              const display = settings?.display
              if (!display) return yield* Effect.fail(new ToolFailure({ message: UNCONFIGURED }))
              const screenshotPath = settings.screenshotPath ?? ConfigComputer.DEFAULT_SCREENSHOT_PATH

              const action = toAction(input)
              if ("error" in action) return yield* Effect.fail(new ToolFailure({ message: action.error }))

              const built = ComputerActions.build(action, { display, screenshotPath })
              if (!built.ok) return yield* Effect.fail(new ToolFailure({ message: built.reason }))

              // One assert for the whole tool: the resource is the ACTION, not a coordinate — a
              // permission rule a person can read ("allow computer/screenshot") and not a pixel.
              yield* permission.assert({
                action: name,
                resources: [input.action],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              // Each command goes through the ONE host-execution gate as literal argv — never a
              // shell string, because `type` carries model-authored text read off an untrusted
              // screen. `overlay` is the functional, non-secret channel the display rides.
              const outputs: string[] = []
              for (const argv of built.argv) {
                const plan = HostExec.plan({
                  shape: { kind: "argv", argv },
                  cwd: location.directory,
                  worktree: location.directory,
                  consent: "none",
                  overlay: { ...built.env },
                })
                if (plan.via === "none") return yield* Effect.fail(new ToolFailure({ message: plan.message }))
                if (plan.via !== "exec")
                  // Unreachable: an argv shape always takes the exec arm. Fail loudly rather than
                  // fall back to a shell, which is the injection this shape exists to prevent.
                  return yield* Effect.fail(new ToolFailure({ message: "computer: refusing a non-argv execution" }))
                const result = yield* processes
                  .run(
                    ChildProcess.make(plan.file, [...plan.args], {
                      env: plan.env.vars,
                      extendEnv: plan.env.inherit,
                    }),
                  )
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `computer: ${plan.file} failed — ${String(error)}` }),
                    ),
                  )
                const text = result.stdout.toString().trim()
                if (text) outputs.push(text)
              }

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
                    action.region
                    ? `screenshot written to ${screenshotPath} — a CROP with its origin at ` +
                      `(${action.region.x},${action.region.y}) and up to ` +
                      `${action.region.width}x${action.region.height} (clipped at the screen edge). ` +
                      `Coordinates read off it are relative to that origin: add it back before clicking.`
                    : `screenshot written to ${screenshotPath}`
                  : outputs.length > 0
                    ? outputs.join("\n")
                    : `${input.action} done`
              return {
                action: input.action,
                ok: true,
                detail,
                ...(action.kind === "screenshot" ? { screenshotPath } : {}),
              }
            }).pipe(
              // The tool's contract is ToolFailure only. Config reads and the process runner have
              // their own error types; a leaked one becomes a defect at settlement rather than an
              // observation the model can act on.
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: `computer: ${String(error)}` }),
              ),
            ),
        })),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/computer",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, AppProcess.node, Location.node, Config.node],
})

/** Re-exported so a caller converting a grounder's output has one obvious place to look. */
export const toPixels = ComputerCoordinates.toPixels
