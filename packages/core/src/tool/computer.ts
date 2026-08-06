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
}).annotate({ identifier: "ComputerTool.Input" })

const Output = Schema.Struct({
  action: Schema.String,
  ok: Schema.Boolean,
  detail: Schema.String,
  screenshotPath: Schema.String.pipe(Schema.optional),
})

/**
 * Turn the model's flat input into the action union. Kept separate from `build` so the schema can
 * stay flat — a model fills a flat object far more reliably than a discriminated union, and the
 * cost is this one translation.
 */
export const toAction = (input: Input): ComputerActions.Action | { readonly error: string } => {
  const point = () =>
    input.x === undefined || input.y === undefined ? undefined : { x: input.x, y: input.y }
  switch (input.action) {
    case "screenshot":
      return { kind: "screenshot" }
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
        [name]: Tool.make({
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
                  ? `screenshot written to ${screenshotPath}`
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
        }),
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
