export * as Host from "./host"

/**
 * The JavaScript side of NovaClaw's own host module (`packages/host/include/host.h`).
 *
 * ⭐ Owner ruling 2026-08-12: one C++ host module replaces the crufty native Node dependencies, built
 * by us so a crash is debuggable. This file is the whole binding — `bun:ffi`, no N-API, no node-gyp.
 *
 * ⚠️ **The ABI version is checked at load and a mismatch REFUSES.** A stale `host.dll` beside newer
 * TypeScript is the ordinary result of a partial rebuild, and calling a changed function through an
 * old binary is the undebuggable crash this module exists to remove. Better a legible error at open
 * than a fault later.
 */

import { dlopen, FFIType, ptr, suffix, type Pointer } from "bun:ffi"
import path from "node:path"

/** Matches `HOST_ABI_VERSION` in host.h. Bump both together, never one. */
export const ABI_VERSION = 2

export type WatchEventType = "create" | "update" | "delete" | "overflow"

export interface WatchEvent {
  readonly type: WatchEventType
  /** Absolute, forward-slashed. Empty only for `overflow`, which names no path. */
  readonly path: string
}

const TYPES: Readonly<Record<number, WatchEventType>> = {
  1: "create",
  2: "update",
  3: "delete",
  4: "overflow",
}

const libraryPath = () =>
  process.env["NOVACLAW_HOST_LIB"] ??
  path.join(path.dirname(Bun.fileURLToPath(import.meta.url)), "..", "build", `host.${suffix}`)

const symbols = {
  host_abi_version: { args: [], returns: FFIType.i32 },
  host_watch_open: {
    args: [FFIType.cstring, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32],
    returns: FFIType.ptr,
  },
  host_watch_poll: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  host_watch_close: { args: [FFIType.ptr], returns: FFIType.void },
} as const

let library: ReturnType<typeof dlopen<typeof symbols>> | undefined

/** Open the library once. Throws with the reason — a missing build is a normal, fixable state. */
const open = () => {
  if (library) return library
  const target = libraryPath()
  const opened = dlopen(target, symbols)
  const found = opened.symbols.host_abi_version()
  if (found !== ABI_VERSION) {
    opened.close()
    throw new Error(
      `host: ABI mismatch — ${target} reports version ${found}, this build expects ${ABI_VERSION}. ` +
        `Rebuild it with \`bun run packages/host/build.ts\`.`,
    )
  }
  library = opened
  return library
}

/** Is the native module present and usable? Never throws — callers gate features on it. */
export const available = (): boolean => {
  try {
    open()
    return true
  } catch {
    return false
  }
}

const readError = (buffer: Uint8Array) => {
  const end = buffer.indexOf(0)
  return new TextDecoder().decode(buffer.subarray(0, end === -1 ? buffer.length : end))
}

/**
 * Decode the poll buffer: `[type byte][UTF-8 path][NUL]`, repeated.
 *
 * Exported for its own test — the wire format is the one place a silent mistake turns into wrong
 * paths rather than an error, and it is pure, so it can be checked without touching a filesystem.
 */
export const decode = (buffer: Uint8Array, length: number): WatchEvent[] => {
  const events: WatchEvent[] = []
  const decoder = new TextDecoder()
  let index = 0
  while (index < length) {
    const type = TYPES[buffer[index]!]
    index += 1
    let end = index
    while (end < length && buffer[end] !== 0) end += 1
    const value = decoder.decode(buffer.subarray(index, end))
    index = end + 1
    // An unrecognised type byte is a version skew the ABI check should have caught; drop the record
    // rather than invent an event, and keep going so one bad byte is not a whole lost drain.
    if (type !== undefined) events.push({ type, path: value })
  }
  return events
}

export interface Watch {
  /** Everything that happened since the last drain. */
  readonly poll: () => WatchEvent[]
  readonly close: () => void
}

/**
 * Watch `directory` and everything under it. Throws with the OS reason when it cannot start.
 *
 * `ignoreDirectories` are folder NAMES dropped natively, before an event is ever queued — that is the
 * point of passing them across rather than filtering here. Richer rules (file globs, whitelists) stay
 * on this side; only the high-volume `node_modules`-shaped noise is worth a place in the ABI.
 */
export const watch = (
  directory: string,
  options?: { readonly bufferBytes?: number; readonly ignoreDirectories?: readonly string[] },
): Watch => {
  const lib = open()
  const error = new Uint8Array(512)
  // A `const char *[]` the native side reads and never keeps — it copies the names into its own set
  // before returning. ⚠️ Both the pointer table AND every string it points at must stay alive across
  // the call; they do because they are locals held until it returns, and letting either be collected
  // first is the classic FFI dangling-pointer bug.
  const names = (options?.ignoreDirectories ?? []).map((name) => Buffer.from(`${name}\0`, "utf8"))
  const table = new BigUint64Array(Math.max(1, names.length))
  names.forEach((buffer, index) => {
    table[index] = BigInt(ptr(buffer))
  })
  const handle = lib.symbols.host_watch_open(
    Buffer.from(`${directory}\0`, "utf8"),
    names.length === 0 ? null : ptr(table),
    names.length,
    ptr(error),
    error.length,
  )
  if (handle === null) throw new Error(`host: could not watch ${directory}: ${readError(error) || "unknown reason"}`)

  // One buffer, reused. Sized so an ordinary drain never needs a second call, while a burst simply
  // takes two — the C side keeps what does not fit rather than truncating a path.
  const buffer = new Uint8Array(options?.bufferBytes ?? 64 * 1024)
  let closed = false

  return {
    poll: () => {
      if (closed) return []
      const written = lib.symbols.host_watch_poll(handle, ptr(buffer), buffer.length, ptr(error), error.length)
      if (written < 0) throw new Error(`host: watch poll failed: ${readError(error) || "unknown reason"}`)
      return decode(buffer, written)
    },
    close: () => {
      // Idempotent on both sides: the C entry point tolerates a second call, and this stops a second
      // poll from using a freed handle — which is the exact fault this module was written to escape.
      if (closed) return
      closed = true
      lib.symbols.host_watch_close(handle as Pointer)
    },
  }
}
