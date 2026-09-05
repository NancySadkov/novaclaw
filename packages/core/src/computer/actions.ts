export * as ComputerActions from "./actions"

import type { ComputerCoordinates } from "./coordinates"

/**
 * Computer Use P1 — the action vocabulary, and what each action becomes on the wire.
 *
 * **Why argv arrays and never a command string.** `host-exec.ts`'s `Shape` is
 * `{shell, command}` or `{runtime, program}` — both take a STRING, so expressing a computer action
 * through it would mean pasting model-authored text into a shell command line. The `type` action
 * carries arbitrary text the model chose; `xdotool type "$TEXT"` with `TEXT` containing `; rm -rf ~`
 * or `$(curl …)` is a shell injection whose payload the grounding model can be talked into writing
 * (the screen is untrusted input — that is the whole premise of the injection guard this program
 * inherits). Emitting argv keeps the text one opaque element that no shell ever parses.
 *
 * ⚠️ **So this module returns `string[][]` and the caller must exec it AS argv.** If it is ever
 * joined into a string to fit an existing seam, every property below is void. `host-exec` grew a
 * plain-argv shape on 2026-08-06 (`{kind:"argv", argv}`), so that prerequisite is CLOSED — the rule
 * it left behind, and the two wrong answers that are still one line away, are on `build` below.
 *
 * **Validated live, and the validation earned its keep.** Every form below was executed against a
 * real Xvfb in the P2 substrate on 2026-08-06 — including the rejection cases — rather than being
 * reasoned about. That run caught a defect the unit tests could not: the first draft put the display
 * in argv as `xdotool --display :99 …`, **a flag `xdotool` does not have**, so every action would
 * have failed at run time with a green suite. The display moved to `env` as a result. ⚠️ The lesson
 * generalises past this module: a unit test pins the argv against the AUTHOR's belief about a tool,
 * never against the tool. Anything here that changes a flag needs another live run.
 */

export type Point = ComputerCoordinates.Point

export type Button = "left" | "middle" | "right"

/** `xdotool`'s numeric buttons. 4/5 are the scroll wheel and are reached through `scroll`. */
const BUTTON_CODE: Record<Button, string> = { left: "1", middle: "2", right: "3" }

export type ScrollDirection = "up" | "down" | "left" | "right"

/** Wheel buttons, in `xdotool click` terms. Horizontal wheel is 6/7 and is not universally honoured. */
const SCROLL_CODE: Record<ScrollDirection, string> = { up: "4", down: "5", left: "6", right: "7" }

/** A rectangle in screen pixels. */
export interface Region {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type Action =
  /**
   * Capture to `path`. The only action that produces bytes rather than an effect.
   *
   * ⚠️ **`region` is the verifier's answer to an animated screen, not a cropping convenience.**
   * A whole-frame digest carries NO signal when anything on screen animates — an attract loop, a
   * video, a clock — which is exactly what a game presents, and it left P3's loop unable to verify a
   * single step. Measured 2026-08-06 in the substrate: with a static target
   * inside the region and a change made well OUTSIDE it, the REGION digest was byte-identical across
   * both captures while the full-frame digest changed. So comparing a region around the acted-on
   * point restores the signal the animation guard removes.
   */
  | { readonly kind: "screenshot"; readonly region?: Region }
  /** Move the pointer. Coordinates are PIXELS — convert with `ComputerCoordinates.toPixels` first. */
  | { readonly kind: "move"; readonly point: Point }
  | { readonly kind: "click"; readonly button: Button; readonly point?: Point }
  | { readonly kind: "double_click"; readonly point?: Point }
  /** Type literal text. The text is never parsed by a shell — see the module note. */
  | { readonly kind: "type"; readonly text: string }
  /** Type literal text and submit it with Return as one semantic action. */
  | { readonly kind: "type_submit"; readonly text: string }
  /** Press a key combination, e.g. `ctrl+s`, `Return`, `alt+Tab`. */
  | { readonly kind: "key"; readonly keys: string }
  /** Select all and copy text from the exact approved foreground application. Windows only. */
  | { readonly kind: "copy_text" }
  | { readonly kind: "scroll"; readonly direction: ScrollDirection; readonly amount: number }
  /** Where the pointer is. Useful as a cheap liveness probe on the substrate. */
  | { readonly kind: "cursor" }

export interface Options {
  /** X display inside the substrate, e.g. `:99`. */
  readonly display: string
  /** Where `screenshot` writes. */
  readonly screenshotPath: string
  /**
   * One human-granted X11 window. When present, screenshot coordinates are window-local and every
   * input event is addressed to this XID; no full-desktop capture is expressible.
   */
  readonly windowID?: string
  /**
   * Inter-keystroke delay for `type`, ms. `xdotool`'s own default is 12 ms; the substrate probe used
   * 5 ms without loss. Kept a knob because a slow remote X connection drops keys at low values.
   */
  readonly typeDelayMs?: number
}

export type Invalid = { readonly ok: false; readonly reason: string }
export type Valid = {
  readonly ok: true
  readonly argv: ReadonlyArray<ReadonlyArray<string>>
  /**
   * Environment every command in `argv` MUST be exec'd with.
   *
   * 🔴 **The display is here and not in argv, because `xdotool` has no `--display` flag.** Measured
   * 2026-08-06 in the substrate: `xdotool --display :99 mousemove 550 400` →
   * `unrecognized option '--display'`, and the same for `click`, `key`, `type` and
   * `getmouselocation`. An earlier draft of this module emitted that flag on every command, so every
   * action would have failed at run time while all of its unit tests passed — the argv was checked
   * against my belief about the tool rather than against the tool.
   *
   * ⚠️ **`DISPLAY` must be SET explicitly, never inherited.** The instance may have its own display,
   * or none: inheriting one either fails on a headless server or — far worse — drives the operator's
   * real screen, which is P6 and is human-gated. The caller composes this env; it does not merge it
   * into an ambient one.
   */
  readonly env: Readonly<Record<string, string>>
}
export type Built = Valid | Invalid

/**
 * `xdotool key` takes a keysym spec: modifiers joined by `+`, ending in a keysym name.
 *
 * ⚠️ **Validated even though argv already blocks shell injection.** Two different problems: argv
 * stops a shell from seeing the string, while this stops `xdotool` itself from being handed
 * something it will interpret — a spec is not free text, and an unvalidated one is how a "key" action
 * quietly becomes "press these forty keys". Conservative on purpose: alphanumerics, `_`, and `+` as
 * the separator. Widen deliberately, with a case that needed it.
 */
const KEYSYM = /^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/

/** Bound on one `scroll` action, so a model cannot ask for 100000 wheel clicks in one call. */
export const MAX_SCROLL = 25

const point = (p: Point): Invalid | undefined => {
  for (const axis of ["x", "y"] as const) {
    const v = p[axis]
    if (!Number.isFinite(v)) return { ok: false, reason: `${axis} is not finite` }
    if (!Number.isInteger(v)) return { ok: false, reason: `${axis} must be a whole pixel, got ${v}` }
    if (v < 0) return { ok: false, reason: `${axis} is negative` }
  }
  return undefined
}

/**
 * Turn one action into the commands that perform it.
 *
 * Returns a LIST of argv arrays because some actions are genuinely two commands — a click at a point
 * is a move then a click. Keeping them separate (rather than `xdotool mousemove X Y click 1`, which
 * also works) means a failure names which half failed, and the caller can interleave a screenshot.
 *
 * ⚠️ **Everything this builds must stay ARGV, and must reach the host through `HostExec.plan`.**
 * `Shape` is `{kind:"shell-command", …}` · `{kind:"runtime-eval", …}` · **`{kind:"argv", argv}`**
 * (`host-exec.ts:73`). `argvOf` returns that third member untouched, and `plan()` routes it to the
 * **exec** arm in both postures — raw exec of `argv[0]`, or wrapped by `AgentJail.wrapArgv` when
 * confined — with an empty argv DENIED rather than exec'ing the empty string. `tool/computer.ts`
 * already hands every array this module builds to `HostExec.plan` in exactly that shape, and
 * `DISPLAY` rides `EnvRequest.overlay`.
 *
 * **The two wrong answers are one line away, which is why they stay named:**
 *  · Join the argv into a shell string to fit `shell-command`. That reintroduces exactly the
 *    injection this module exists to prevent, on text a model chose.
 *  · Exec argv directly and skip the gate. That is the second call site ruling 6 forbids, and it is
 *    the mechanism that produced the COMSPEC divergence.
 *
 * Both are guarded mechanically rather than by this prose: `plan()` refuses to let an argv shape
 * fall through to the `via:"shell"` arm, and `computer/one-exec-gate.test.ts` fails if anything in
 * the computer path starts a process itself. (Moved here 2026-09-01 from a `REQUIRES_ARGV_SHAPE =
 * true` constant that existed only to anchor it — .)
 */
export const build = (action: Action, options: Options): Built => {
  // The display travels in `env`, not in argv — `xdotool` has no `--display` flag (measured).
  const env = { DISPLAY: options.display } as const
  const xdotool = (...args: string[]) => ["xdotool", ...args]
  const windowArgs = options.windowID === undefined ? [] : ["--window", options.windowID]

  switch (action.kind) {
    case "copy_text":
      return { ok: false, reason: "copy_text is available only for an exact native Windows application binding" }
    case "screenshot": {
      const validateRegion = (r: Region): Invalid | undefined => {
        for (const [name, value] of [
          ["x", r.x],
          ["y", r.y],
          ["width", r.width],
          ["height", r.height],
        ] as const) {
          if (!Number.isInteger(value))
            return { ok: false, reason: `region ${name} must be a whole pixel, got ${value}` }
          if (name === "x" || name === "y" ? value < 0 : value < 1)
            return { ok: false, reason: `region ${name} is out of range: ${value}` }
        }
      }
      if (action.region) {
        const invalid = validateRegion(action.region)
        if (invalid) return invalid
      }
      if (options.windowID !== undefined) {
        const crop = action.region
          ? ["-crop", `${action.region.width}x${action.region.height}+${action.region.x}+${action.region.y}`, "+repage"]
          : []
        return {
          ok: true,
          env,
          // ImageMagick captures the selected window's backing pixels, not whatever overlaps it on
          // the ambient desktop. `xWindowArg` is prepared by the validated binding resolver.
          argv: [["import", "-window", options.windowID, ...crop, options.screenshotPath]],
        }
      }
      // `-o` overwrites: the substrate reuses one path per capture and a stale file read as a fresh
      // frame is the worst possible failure for a loop that decides what to click from it.
      if (!action.region) return { ok: true, env, argv: [["scrot", "-o", options.screenshotPath]] }
      const r = action.region
      // `scrot -a x,y,w,h` — run against the real `scrot` (1.10) in the substrate on 2026-08-06 in
      // THIS flag order, not assumed from the flag's existence: a flag that is not there fails at run
      // time under a green unit suite, which is exactly how `xdotool --display` got through.
      //
      // ⚠️ **A region that overruns the screen is CLIPPED, silently and without an error.** Measured:
      // `-a 1200,760,400,400` on a 1280x800 display wrote an 80x40 file, exit 0. Harmless for the
      // verifier — both captures clip identically, so digest equality still holds — but it means the
      // returned size is an upper bound, and no caller may report the requested size as the file's
      // size. `tool/computer.ts` states the ORIGIN as fact and the size as "up to" for this reason.
      // (A zero or negative extent is rejected above; `scrot` rejects it too, with "'0' is too small".)
      return {
        ok: true,
        env,
        argv: [["scrot", "-o", "-a", `${r.x},${r.y},${r.width},${r.height}`, options.screenshotPath]],
      }
    }

    case "cursor":
      if (options.windowID !== undefined)
        return { ok: false, reason: "cursor is unavailable in a window scope; capture the window instead" }
      return { ok: true, env, argv: [xdotool("getmouselocation")] }

    case "move": {
      const bad = point(action.point)
      if (bad) return bad
      return {
        ok: true,
        env,
        argv: [xdotool("mousemove", ...windowArgs, String(action.point.x), String(action.point.y))],
      }
    }

    case "click":
    case "double_click": {
      const code = action.kind === "click" ? BUTTON_CODE[action.button] : BUTTON_CODE.left
      if (code === undefined) return { ok: false, reason: `unknown button` }
      const commands: string[][] = []
      if (action.point) {
        const bad = point(action.point)
        if (bad) return bad
        commands.push(xdotool("mousemove", ...windowArgs, String(action.point.x), String(action.point.y)))
      }
      commands.push(
        action.kind === "double_click"
          ? xdotool("click", ...windowArgs, "--repeat", "2", code)
          : xdotool("click", ...windowArgs, code),
      )
      return { ok: true, env, argv: commands }
    }

    case "type":
    case "type_submit": {
      if (action.text.length === 0) return { ok: false, reason: "nothing to type" }
      // `--` ends option parsing so text beginning with `-` is typed rather than read as a flag.
      // The text stays ONE argv element; nothing splits it and no shell sees it.
      const argv = [xdotool("type", ...windowArgs, "--delay", String(options.typeDelayMs ?? 12), "--", action.text)]
      if (action.kind === "type_submit") argv.push(xdotool("key", ...windowArgs, "--", "Return"))
      return {
        ok: true,
        env,
        argv,
      }
    }

    case "key": {
      if (!KEYSYM.test(action.keys)) return { ok: false, reason: `not a keysym spec: ${action.keys}` }
      return { ok: true, env, argv: [xdotool("key", ...windowArgs, "--", action.keys)] }
    }

    case "scroll": {
      const code = SCROLL_CODE[action.direction]
      if (code === undefined) return { ok: false, reason: `unknown direction` }
      if (!Number.isInteger(action.amount) || action.amount < 1)
        return { ok: false, reason: `amount must be a positive whole number, got ${action.amount}` }
      if (action.amount > MAX_SCROLL) return { ok: false, reason: `amount exceeds ${MAX_SCROLL}` }
      return {
        ok: true,
        env,
        argv: [xdotool("click", ...windowArgs, "--repeat", String(action.amount), code)],
      }
    }
  }
}

