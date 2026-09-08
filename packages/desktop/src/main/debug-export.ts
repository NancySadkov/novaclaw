import { createReadStream, createWriteStream } from "node:fs"
import { lstat, open, opendir, rm } from "node:fs/promises"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"
import { finished } from "node:stream/promises"

export type DebugExportEntry = {
  readonly name: string
  readonly path?: string
  readonly data?: string | Uint8Array
  readonly fingerprint?: { readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number }
}

export interface DebugExportBudget {
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
  readonly maxDepth: number
  readonly deadlineAt: number
  readonly signal?: AbortSignal
}

export const DEFAULT_DEBUG_EXPORT_LIMITS = {
  maxFiles: 64,
  maxFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 40 * 1024 * 1024,
  maxDepth: 4,
  timeoutMs: 10_000,
} as const

export interface DebugExportCollection {
  readonly entries: DebugExportEntry[]
  readonly omitted: { readonly symlinks: number; readonly races: number; readonly budget: number }
  readonly bytes: number
}

const check = (budget: Pick<DebugExportBudget, "deadlineAt" | "signal">) => {
  budget.signal?.throwIfAborted()
  if (Date.now() > budget.deadlineAt) throw new DOMException("Diagnostic export timed out", "TimeoutError")
}

/** Async, bounded traversal of a desktop-owned log root. Symlinks are records, never authority. */
export async function collectRecentFiles(
  dir: string,
  prefix: string,
  windowMs: number,
  budget: DebugExportBudget,
  now = Date.now(),
): Promise<DebugExportCollection> {
  const cutoff = now - windowMs
  const entries: DebugExportEntry[] = []
  const omitted = { symlinks: 0, races: 0, budget: 0 }
  let bytes = 0

  const walk = async (current: string, relative: string, depth: number): Promise<void> => {
    check(budget)
    let directory
    try {
      directory = await opendir(current)
    } catch {
      omitted.races++
      return
    }
    try {
      for await (const item of directory) {
        check(budget)
        const file = join(current, item.name)
        const child = relative ? join(relative, item.name) : item.name
        let info
        try {
          info = await lstat(file)
        } catch {
          omitted.races++
          continue
        }
        if (info.isSymbolicLink()) {
          omitted.symlinks++
          continue
        }
        if (info.isDirectory()) {
          if (depth >= budget.maxDepth) omitted.budget++
          else await walk(file, child, depth + 1)
          continue
        }
        if (!info.isFile() || info.mtimeMs < cutoff || file.endsWith(".heapsnapshot")) continue
        if (
          entries.length >= budget.maxFiles ||
          info.size > budget.maxFileBytes ||
          bytes + info.size > budget.maxTotalBytes
        ) {
          omitted.budget++
          continue
        }
        bytes += info.size
        entries.push({
          name: join(prefix, child).replace(/\\/g, "/"),
          path: file,
          fingerprint: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs },
        })
      }
    } catch (error) {
      if (budget.signal?.aborted) throw error
      omitted.races++
    }
  }

  await walk(dir, "", 0)
  return { entries, omitted, bytes }
}

/** The remote host's bytes become data. A path-shaped string can never become a local file source. */
export const serverDiagnosticEntry = (diagnostics: string): DebugExportEntry => ({
  name: "server/novaclaw.log",
  data: diagnostics,
})

const sameIdentity = (
  expected: NonNullable<DebugExportEntry["fingerprint"]>,
  actual: { dev: number; ino: number },
) => expected.dev === actual.dev && expected.ino === actual.ino

/** Stream entries directly into the destination zip; no file or complete archive is held in memory. */
export async function writeDebugZip(
  output: string,
  entries: readonly DebugExportEntry[],
  options: { readonly signal?: AbortSignal; readonly deadlineAt: number },
) {
  // Debug export is user-triggered. Keep the archive implementation out of the desktop cold-start
  // graph; the caller already owns the bounded, cancellable export operation below.
  const { TextReader, Uint8ArrayReader, ZipWriter } = await import("@zip.js/zip.js")
  const destination = createWriteStream(output, { flags: "wx", signal: options.signal })
  const writer = new ZipWriter(Writable.toWeb(destination) as WritableStream)
  try {
    for (const entry of entries) {
      check(options)
      if (entry.data !== undefined) {
        await writer.add(
          entry.name,
          typeof entry.data === "string" ? new TextReader(entry.data) : new Uint8ArrayReader(entry.data),
          { signal: options.signal },
        )
        continue
      }
      if (!entry.path || !entry.fingerprint) continue

      let before
      try {
        before = await lstat(entry.path)
      } catch {
        continue
      }
      if (before.isSymbolicLink() || !before.isFile() || !sameIdentity(entry.fingerprint, before)) continue

      let handle
      try {
        handle = await open(entry.path, "r")
      } catch {
        // Deleted or locked after traversal: omit that one record, keep the rest of the archive.
        continue
      }
      try {
        const opened = await handle.stat()
        if (!opened.isFile() || !sameIdentity(entry.fingerprint, opened)) continue
        // A live log may grow after traversal. Read no more than the size already charged to the
        // total budget; a shrink is safe and a replacement has a different identity above.
        const bytes = Math.min(opened.size, entry.fingerprint.size)
        if (bytes === 0) {
          await writer.add(entry.name, new Uint8ArrayReader(new Uint8Array()), { signal: options.signal })
          continue
        }
        const source = createReadStream(entry.path, {
          fd: handle.fd,
          autoClose: false,
          start: 0,
          end: bytes - 1,
          signal: options.signal,
        })
        await writer.add(entry.name, Readable.toWeb(source) as unknown as ReadableStream, { signal: options.signal })
      } finally {
        await handle.close().catch(() => undefined)
      }
    }
    await writer.close()
    await finished(destination)
  } catch (error) {
    destination.destroy()
    await rm(output, { force: true }).catch(() => undefined)
    throw error
  }
}
