import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { verifyArchiveLayout } from "./archive-layout"

function fixture(run: (archive: string, bytes: Buffer) => void) {
  // The verifier is content-based. A synthetic `.asar` name makes Windows security/indexing open
  // the just-closed fixture asynchronously and turns teardown into a nondeterministic EBUSY race.
  const archive = join(tmpdir(), `novaclaw-archive-layout-${randomUUID()}.bin`)
  try {
    const json = Buffer.from(
      JSON.stringify({
        files: {
          "first.js": { offset: "0", size: 3 },
          "second.js": { offset: "3", size: 3 },
          "native.node": { size: 10, unpacked: true },
          alias: { link: "first.js" },
        },
      }),
    )
    const headerSize = 8 + Math.ceil(json.length / 4) * 4
    const header = Buffer.alloc(8 + headerSize)
    header.writeUInt32LE(4, 0)
    header.writeUInt32LE(headerSize, 4)
    header.writeUInt32LE(headerSize - 4, 8)
    header.writeUInt32LE(json.length, 12)
    json.copy(header, 16)
    const bytes = Buffer.concat([header, Buffer.from("abcdef")])
    writeFileSync(archive, bytes)
    run(archive, bytes)
  } finally {
    rmSync(archive, { force: true })
  }
}

test("accepts packed extents while excluding unpacked files and links", () =>
  fixture((archive) => {
    expect(() => verifyArchiveLayout(archive)).not.toThrow()
  }))

test("rejects a source that shrank between its recorded size and the archive write", () =>
  fixture((archive, bytes) => {
    writeFileSync(archive, bytes.subarray(0, bytes.length - 1))
    expect(() => verifyArchiveLayout(archive)).toThrow("file table requires")
  }))

test("rejects a source that grew after its size was recorded", () =>
  fixture((archive, bytes) => {
    writeFileSync(archive, Buffer.concat([bytes, Buffer.from("extra")]))
    expect(() => verifyArchiveLayout(archive)).toThrow("file table requires")
  }))

test("rejects a truncated header", () =>
  fixture((archive) => {
    writeFileSync(archive, Buffer.from([4, 0]))
    expect(() => verifyArchiveLayout(archive)).toThrow("truncated header")
  }))
