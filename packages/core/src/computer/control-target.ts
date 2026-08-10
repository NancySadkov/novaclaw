export * as ComputerControlTarget from "./control-target"

/** A display owned by a sandbox instance. No ambient desktop is reachable through this form. */
export interface Sandbox {
  readonly kind: "sandbox-x11"
  readonly display: string
}

/** One human-selected X11 application window on the instance's real desktop. */
export interface X11Window {
  readonly kind: "x11-window"
  readonly display: string
  /** Decimal X window id, retained as text because XIDs are unsigned 32-bit values. */
  readonly windowID: string
  readonly processID: number
  /** The application half (last value) of WM_CLASS, e.g. `Chromium`. */
  readonly wmClass: string
}

/** One approved, visible top-level window on the active Windows desktop. */
export interface WindowsWindow {
  readonly kind: "windows-window"
  /** Decimal HWND, retained as text because a 64-bit handle may exceed JS's exact integer range. */
  readonly windowHandle: string
  readonly processID: number
  /** Executable basename, the same stable app id Windows Codex allowlists (for example dosbox-x.exe). */
  readonly executable: string
}

export type Target = Sandbox | X11Window | WindowsWindow
export type Parsed = { readonly ok: true; readonly target: Target } | { readonly ok: false; readonly reason: string }

const NON_EMPTY = /\S/
const UNSIGNED_32_MAX = 0xffff_ffffn

export const sandbox = (display: string): Sandbox => ({ kind: "sandbox-x11", display })

/** Explicit session-local sandbox binding; a plain display is never accepted on the component wire. */
export const encodeSandbox = (display: string): string => `x11-sandbox:${encodeURIComponent(display)}`

/**
 * The session component stays a string on its existing wire, but the tag makes authority explicit.
 * Percent encoding keeps delimiters out of operator/model-authored values without inventing escaping.
 */
export const encodeWindow = (target: Omit<X11Window, "kind">): string =>
  [
    "x11-window",
    encodeURIComponent(target.display),
    target.windowID,
    String(target.processID),
    encodeURIComponent(target.wmClass),
  ].join(":")

export const encodeWindowsWindow = (target: Omit<WindowsWindow, "kind">): string =>
  ["windows-window", target.windowHandle, String(target.processID), encodeURIComponent(target.executable)].join(":")

export const parse = (value: string): Parsed => {
  const parts = value.split(":")
  if (parts.length === 2 && parts[0] === "x11-sandbox") {
    let display: string
    try {
      display = decodeURIComponent(parts[1]!)
    } catch {
      return { ok: false, reason: "The sandbox binding contains invalid percent encoding." }
    }
    return NON_EMPTY.test(display)
      ? { ok: true, target: sandbox(display) }
      : { ok: false, reason: "The sandbox binding has no display." }
  }
  if (parts.length === 4 && parts[0] === "windows-window") {
    const windowHandle = parts[1]!
    if (!/^[1-9][0-9]*$/.test(windowHandle))
      return { ok: false, reason: "The Windows real-desktop window handle is invalid." }
    const processID = Number(parts[2])
    if (!Number.isSafeInteger(processID) || processID < 1)
      return { ok: false, reason: "The Windows real-desktop process id is invalid." }
    let executable: string
    try {
      executable = decodeURIComponent(parts[3]!)
    } catch {
      return { ok: false, reason: "The Windows real-desktop grant contains invalid percent encoding." }
    }
    if (!/^[^\\/:*?"<>|]+\.exe$/i.test(executable))
      return { ok: false, reason: "The Windows real-desktop executable is not a .exe basename." }
    return { ok: true, target: { kind: "windows-window", windowHandle, processID, executable } }
  }
  if (parts.length !== 5 || parts[0] !== "x11-window")
    return {
      ok: false,
      reason:
        "The control_binding is not a human-scoped real-desktop grant. Expected " +
        "`x11-window:<encoded-display>:<window-id>:<pid>:<encoded-WM_CLASS>` or " +
        "`windows-window:<handle>:<pid>:<encoded-executable>` or `x11-sandbox:<encoded-display>`; " +
        "a plain display is never accepted.",
    }
  let display: string
  let wmClass: string
  try {
    display = decodeURIComponent(parts[1]!)
    wmClass = decodeURIComponent(parts[4]!)
  } catch {
    return { ok: false, reason: "The real-desktop grant contains invalid percent encoding." }
  }
  if (!NON_EMPTY.test(display)) return { ok: false, reason: "The real-desktop grant has no display." }
  if (!NON_EMPTY.test(wmClass)) return { ok: false, reason: "The real-desktop grant has no WM_CLASS." }
  const windowID = parts[2]!
  if (!/^[1-9][0-9]*$/.test(windowID)) return { ok: false, reason: "The real-desktop window id is invalid." }
  const xid = BigInt(windowID)
  if (xid > UNSIGNED_32_MAX) return { ok: false, reason: "The real-desktop window id exceeds X11's range." }
  const processID = Number(parts[3])
  if (!Number.isSafeInteger(processID) || processID < 1)
    return { ok: false, reason: "The real-desktop process id is invalid." }
  return { ok: true, target: { kind: "x11-window", display, windowID, processID, wmClass } }
}

export const xWindowArg = (windowID: string): string => `0x${BigInt(windowID).toString(16)}`

export const parseWindowPID = (stdout: string): number | undefined => {
  const value = Number(stdout.trim())
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

export const parseWindowID = (stdout: string): string | undefined => {
  const value = stdout.trim()
  if (!/^(?:[1-9][0-9]*|0x[0-9a-f]+)$/i.test(value)) return undefined
  const parsed = BigInt(value)
  return parsed <= UNSIGNED_32_MAX ? parsed.toString(10) : undefined
}

/** Candidate XIDs from `xwininfo -tree`, including the queried frame and every descendant. */
export const parseWindowTree = (stdout: string): string[] => {
  const result: string[] = []
  const seen = new Set<string>()
  for (const match of stdout.matchAll(/\b0x[0-9a-f]+\b/gi)) {
    const value = parseWindowID(match[0])
    if (value === undefined || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

export const parseRootWindowID = (stdout: string): string | undefined => {
  const match = stdout.match(/Root window id:\s*(0x[0-9a-f]+)/i)
  return match ? parseWindowID(match[1]!) : undefined
}

export const resolveSelectedClient = (
  selectedWindowID: string,
  treeOutput: string,
  clientListOutput: string,
): { readonly ok: true; readonly windowID: string } | { readonly ok: false; readonly reason: string } => {
  if (parseRootWindowID(treeOutput) === selectedWindowID)
    return { ok: false, reason: "the desktop background was selected; click the application window itself" }
  const descendants = new Set(parseWindowTree(treeOutput))
  descendants.add(selectedWindowID)
  const candidates = parseWindowTree(clientListOutput).filter((id) => descendants.has(id))
  if (candidates.length === 0)
    return {
      ok: false,
      reason: "the selected window did not contain one EWMH application client, so it cannot be scoped safely",
    }
  if (candidates.length > 1)
    return {
      ok: false,
      reason:
        "the selected window contained more than one application client, so the grant is ambiguous and was refused",
    }
  return { ok: true, windowID: candidates[0]! }
}

export const parseWmClass = (stdout: string): string | undefined => {
  const matches = [...stdout.matchAll(/"((?:\\.|[^"\\])*)"/g)]
  const encoded = matches.at(-1)?.[0]
  if (encoded === undefined) return undefined
  try {
    const value = JSON.parse(encoded)
    return typeof value === "string" && NON_EMPTY.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

export const verifyWindowIdentity = (
  target: X11Window,
  pidOutput: string,
  classOutput: string,
): { readonly ok: true } | { readonly ok: false; readonly actualPID?: number; readonly actualClass?: string } => {
  const actualPID = parseWindowPID(pidOutput)
  const actualClass = parseWmClass(classOutput)
  return actualPID === target.processID && actualClass === target.wmClass
    ? { ok: true }
    : {
        ok: false,
        ...(actualPID === undefined ? {} : { actualPID }),
        ...(actualClass === undefined ? {} : { actualClass }),
      }
}

export const permissionResource = (target: Target, action: string): string =>
  target.kind === "sandbox-x11"
    ? action
    : target.kind === "x11-window"
      ? `x11-window/${encodeURIComponent(target.wmClass)}/${target.processID}/${target.windowID}/${action}`
      : `windows-window/${encodeURIComponent(target.executable)}/${target.processID}/${target.windowHandle}/${action}`

/** P6's OFF-C rule: the sandbox remains usable, while a real desktop is unavailable by design. */
export const offlineRealDesktopRefusal = (offlineEnabled: boolean): string | undefined =>
  offlineEnabled
    ? "real-desktop control is unavailable in offline/airgap mode; use an isolated sandbox display or turn offline mode off"
    : undefined
