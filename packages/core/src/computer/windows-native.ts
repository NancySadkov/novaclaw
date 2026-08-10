export * as WindowsComputer from "./windows-native"

import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import helperSource from "./windows-helper.ps1" with { type: "text" }
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

export const build = (
  action: ComputerActions.Action,
  target: ComputerControlTarget.WindowsWindow,
  inspection: Inspection,
  helperPath: string,
  screenshotPath: string,
): Built => {
  const command = (...args: string[]) => [...base(helperPath, action.kind), "-Handle", target.windowHandle, ...args]
  const coordinate = (value: number, extent: number) => {
    if (!Number.isInteger(value) && value > 0 && value <= 1)
      return Math.min(extent - 1, Math.round(value * extent))
    if (value >= 0 && value <= 1000) return Math.min(extent - 1, Math.round((value / 1000) * extent))
    return value
  }
  const point = (value: ComputerActions.Point | undefined): string[] =>
    value === undefined
      ? []
      : ["-X", String(coordinate(value.x, inspection.width)), "-Y", String(coordinate(value.y, inspection.height))]

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
    case "move":
      return { ok: true, env: {}, argv: [command(...point(action.point))] }
    case "click": {
      const argv: string[][] = []
      if (action.point) argv.push([...base(helperPath, "move"), "-Handle", target.windowHandle, ...point(action.point)])
      argv.push(command("-Button", action.button))
      return { ok: true, env: {}, argv }
    }
    case "double_click": {
      const argv: string[][] = []
      if (action.point) argv.push([...base(helperPath, "move"), "-Handle", target.windowHandle, ...point(action.point)])
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
