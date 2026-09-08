export * as WindowsComputer from "./windows-native"

import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import helperSource from "./windows-helper.ps1" with { type: "text" }
import { ComputerCoordinates } from "./coordinates"
import type { ComputerActions } from "./actions"
import type { ComputerControlTarget } from "./control-target"

const HELPER_DIGEST = createHash("sha256").update(helperSource).digest("hex").slice(0, 16)
const HELPER_DIR = path.join(tmpdir(), "novaclaw-computer")
const HELPER_PATH = path.join(HELPER_DIR, `windows-helper-${HELPER_DIGEST}.ps1`)

export const ensureHelper = async (): Promise<string> => {
  const current = await readFile(HELPER_PATH, "utf8").catch(() => undefined)
  if (current === helperSource) return HELPER_PATH
  await mkdir(HELPER_DIR, { recursive: true })
  await writeFile(HELPER_PATH, helperSource, { encoding: "utf8", mode: 0o600 })
  return HELPER_PATH
}

const base = (helperPath: string, operation: string): string[] => [
  "powershell.exe",
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  helperPath,
  "-Operation",
  operation,
]

export const bindArgv = (helperPath: string, executable: string): string[] => [
  ...base(helperPath, "bind"),
  "-Executable",
  executable,
]

export const inspectArgv = (helperPath: string, handle: string): string[] => [
  ...base(helperPath, "inspect"),
  "-Handle",
  handle,
]

export interface Inspection {
  readonly handle: string
  readonly processID: number
  readonly executable: string
  readonly title: string
  readonly visible: boolean
  readonly minimized: boolean
  readonly foreground: boolean
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export const parseInspection = (stdout: string): Inspection | undefined => {
  try {
    const value = JSON.parse(stdout.trim()) as Partial<Inspection>
    return typeof value.handle === "string" &&
      /^[1-9][0-9]*$/.test(value.handle) &&
      typeof value.processID === "number" &&
      Number.isSafeInteger(value.processID) &&
      value.processID > 0 &&
      typeof value.executable === "string" &&
      typeof value.title === "string" &&
      typeof value.visible === "boolean" &&
      typeof value.minimized === "boolean" &&
      typeof value.foreground === "boolean" &&
      typeof value.x === "number" &&
      typeof value.y === "number" &&
      typeof value.width === "number" &&
      typeof value.height === "number"
      ? (value as Inspection)
      : undefined
  } catch {
    return undefined
  }
}

export type Built =
  | { readonly ok: true; readonly argv: ReadonlyArray<ReadonlyArray<string>>; readonly env: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly reason: string }

/** Say what went wrong in the caller's own vocabulary, so a refusal names the declared space. */
const conversionReason = (
  error: ComputerCoordinates.ConversionError,
  space: ComputerCoordinates.Space,
): string => {
  switch (error.kind) {
    case "not-finite":
      return `${error.axis}=${error.value} is not a finite coordinate`
    case "viewport-invalid":
      return `the approved window reports no usable size (${error.viewport.width}x${error.viewport.height})`
    case "out-of-range":
      return (
        `${error.axis}=${error.value} is outside the declared ${space} range 0..${error.max}` +
        (error.alsoValidAs.length === 0 ? "" : ` — it would be in range as ${error.alsoValidAs.join(" or ")}`)
      )
  }
}

/**
 * Lower one action to helper argv.
 *
 * 🔴 **`space` is DECLARED BY THE CALLER and is never inferred here.** `coordinates.ts` states the
 * ban in red and gives the reason: the spaces overlap by construction, so inference can only be made
 * *usually* correct, and its failure is a click that lands somewhere else with exit 0 and no log.
 * This function used to hand-roll exactly that inference, and got the boundary wrong in the one
 * direction nothing can detect: `Number.isInteger(1)` is true, so `x: 1` — the right edge, as a
 * fraction — took the 0..1000 branch and became pixel 1, the LEFT edge.
 *
 * Out of range is a REFUSAL and nothing is clamped, for the same reason `toPixels` refuses: a clamped
 * stray point is a silent misclick wearing a success, and the refusal carries `alsoValidAs`, which is
 * what turns "the model cannot ground" into "the space is declared wrong".
 */
export const build = (
  action: ComputerActions.Action,
  target: ComputerControlTarget.WindowsWindow,
  inspection: Inspection,
  helperPath: string,
  screenshotPath: string,
  space: ComputerCoordinates.Space,
): Built => {
  const command = (...args: string[]) => [...base(helperPath, action.kind), "-Handle", target.windowHandle, ...args]
  const viewport = { width: inspection.width, height: inspection.height }
  type Located = { readonly ok: true; readonly args: string[] } | { readonly ok: false; readonly reason: string }
  const point = (value: ComputerActions.Point | undefined): Located => {
    if (value === undefined) return { ok: true, args: [] }
    const converted = ComputerCoordinates.toPixels(value, space, viewport)
    if (!converted.ok) return { ok: false, reason: conversionReason(converted.error, space) }
    // ⚠️ **Nothing is clamped on the way out, deliberately** (G8). The predecessor pinned every
    // coordinate to `extent - 1`, which is why the top of a normalized range silently became the last
    // pixel instead of saying anything. The helper's own `Move` refuses a point outside the approved
    // window, so the residual — the exact top of a normalized range mapping one past the last pixel —
    // is a LOUD refusal naming the window, not a click on whatever is next door.
    return { ok: true, args: ["-X", String(converted.point.x), "-Y", String(converted.point.y)] }
  }

  switch (action.kind) {
    case "screenshot":
      return {
        ok: true,
        env: {},
        argv: [
          command(
            "-Path",
            screenshotPath,
            ...(action.region
              ? ["-Region", `${action.region.x},${action.region.y},${action.region.width},${action.region.height}`]
              : []),
          ),
        ],
      }
    case "move": {
      const located = point(action.point)
      if (!located.ok) return { ok: false, reason: located.reason }
      return { ok: true, env: {}, argv: [command(...located.args)] }
    }
    case "click": {
      const located = point(action.point)
      if (!located.ok) return { ok: false, reason: located.reason }
      const argv: string[][] = []
      if (action.point) argv.push([...base(helperPath, "move"), "-Handle", target.windowHandle, ...located.args])
      argv.push(command("-Button", action.button))
      return { ok: true, env: {}, argv }
    }
    case "double_click": {
      const located = point(action.point)
      if (!located.ok) return { ok: false, reason: located.reason }
      const argv: string[][] = []
      if (action.point) argv.push([...base(helperPath, "move"), "-Handle", target.windowHandle, ...located.args])
      argv.push(command())
      return { ok: true, env: {}, argv }
    }
    case "type":
    case "type_submit":
      return {
        ok: true,
        env: {},
        argv: [command("-TextBase64", Buffer.from(action.text, "utf8").toString("base64"))],
      }
    case "key":
      return { ok: true, env: {}, argv: [command("-Keys", action.keys)] }
    case "copy_text":
      return { ok: true, env: {}, argv: [command()] }
    case "scroll":
      return {
        ok: true,
        env: {},
        argv: [command("-Direction", action.direction, "-Amount", String(action.amount))],
      }
    case "cursor":
      return { ok: true, env: {}, argv: [command()] }
  }
}

export const verifyIdentity = (
  target: ComputerControlTarget.WindowsWindow,
  inspection: Inspection,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } => {
  if (inspection.handle !== target.windowHandle)
    return { ok: false, reason: `window handle changed to ${inspection.handle}` }
  if (inspection.processID !== target.processID)
    return { ok: false, reason: `process changed to pid ${inspection.processID}` }
  if (inspection.executable.toLowerCase() !== target.executable.toLowerCase())
    return { ok: false, reason: `application changed to ${inspection.executable}` }
  if (!inspection.visible) return { ok: false, reason: "approved window is no longer visible" }
  if (inspection.minimized) return { ok: false, reason: "approved window is minimized" }
  if (!inspection.foreground) return { ok: false, reason: "approved window is not the foreground application" }
  return { ok: true }
}
