// File-window IO for the hex tools — positioned reads/writes over node:fs so a multi-GB
// image is never loaded whole (mirrors the trash store's plain-async style; the tools wrap
// these in Effect.tryPromise). Pure-of-Effect so they unit-test with mkdtemp fixtures.
export * as HexIo from "./hex-io"

import fs from "node:fs/promises"

/** Hard per-call ceiling — 8 KiB of bytes is ~38 KB of dump text, a safe context slice. */
export const MAX_HEX_BYTES = 8_192
/** Default window when the model omits `length`. */
export const DEFAULT_HEX_BYTES = 1_024

export interface HexWindow {
  readonly bytes: Uint8Array
  /** Total file size, so the caller can report paging (`next` offset). */
  readonly size: number
}

/** Read `length` bytes at `offset` without loading the rest of the file. */
export async function readWindow(path: string, offset: number, length: number): Promise<HexWindow> {
  const handle = await fs.open(path, "r")
  try {
    const stat = await handle.stat()
    if (offset > stat.size) throw new Error(`Offset ${offset} is beyond the end of the file (${stat.size} bytes)`)
    const want = Math.min(length, stat.size - offset)
    const buffer = Buffer.alloc(want)
    let done = 0
    while (done < want) {
      const { bytesRead } = await handle.read(buffer, done, want - done, offset + done)
      if (bytesRead === 0) break
      done += bytesRead
    }
    return { bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, done), size: stat.size }
  } finally {
    await handle.close()
  }
}

export interface PatchResult {
  readonly bytesWritten: number
  /** File size after the patch. */
  readonly size: number
  /** True when the file did not exist and was created. */
  readonly created: boolean
}

/**
 * Write `bytes` at `offset` in place (never truncates the rest of the file). The file is
 * created when missing — but only for `offset === 0`; patching a hole into a nonexistent
 * file is always a mistake. `offset` may be at most the current size (append), never past it.
 */
export async function writePatch(path: string, offset: number, bytes: Uint8Array): Promise<PatchResult> {
  let created = false
  let handle: fs.FileHandle
  try {
    handle = await fs.open(path, "r+")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    if (offset !== 0) throw new Error(`File does not exist — write-hex can only create a new file at offset 0`)
    handle = await fs.open(path, "w+")
    created = true
  }
  try {
    const stat = await handle.stat()
    if (offset > stat.size)
      throw new Error(`Offset ${offset} is past the end of the file (${stat.size} bytes) — appending starts AT the size`)
    let done = 0
    while (done < bytes.length) {
      const { bytesWritten } = await handle.write(
        Buffer.from(bytes.buffer, bytes.byteOffset + done, bytes.length - done),
        0,
        bytes.length - done,
        offset + done,
      )
      done += bytesWritten
    }
    const after = await handle.stat()
    return { bytesWritten: done, size: after.size, created }
  } finally {
    await handle.close()
  }
}
