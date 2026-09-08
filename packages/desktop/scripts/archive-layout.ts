import { closeSync, fstatSync, openSync, readSync } from "node:fs"

type Entry = { files?: Record<string, Entry>; offset?: string; size?: number; unpacked?: boolean; link?: string }

/** A changing input can leave ASAR's recorded sizes different from the payload it actually wrote.
 * Check the finished container before signing or launching it; searching opaque bytes cannot detect
 * this because the JavaScript is present but the loader reads it at the wrong offset. */
export function verifyArchiveLayout(archive: string): void {
  const fd = openSync(archive, "r")
  const fail = (detail: string): never => {
    throw new Error(`Invalid packaged archive ${archive}: ${detail}. Rebuild without changing packaging inputs.`)
  }
  try {
    const size = fstatSync(fd).size
    const read = (length: number, position: number) => {
      const bytes = Buffer.alloc(length)
      let received = 0
      while (received < length) {
        const next = readSync(fd, bytes, received, length - received, position + received)
        if (next === 0) fail("truncated header")
        received += next
      }
      return bytes
    }
    const prefix = read(8, 0)
    const headerSize = prefix.readUInt32LE(4)
    if (prefix.readUInt32LE(0) !== 4 || headerSize < 8 || headerSize > size - 8) fail("invalid header size")
    const header = read(headerSize, 8)
    const jsonSize = header.readUInt32LE(4)
    if (jsonSize > headerSize - 8) fail("invalid header string")
    const root = JSON.parse(header.subarray(8, 8 + jsonSize).toString("utf8")) as Entry
    if (!root.files) fail("missing file table")
    const spans: { offset: number; size: number }[] = []
    const visit = (entry: Entry) => {
      if (entry.files) return Object.values(entry.files).forEach(visit)
      if (entry.unpacked || entry.link !== undefined) return
      const offset = Number(entry.offset)
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(entry.size) || entry.size! < 0)
        fail("invalid file extent")
      spans.push({ offset, size: entry.size! })
    }
    visit(root)
    spans.sort((left, right) => left.offset - right.offset || left.size - right.size)
    let end = 0
    for (const span of spans) {
      if (span.offset !== end) fail("file extents overlap or leave a gap")
      end += span.size
    }
    const expected = 8 + headerSize + end
    if (expected !== size) fail(`file table requires ${expected} bytes; archive contains ${size}`)
  } finally {
    closeSync(fd)
  }
}
