import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseHexInput, hexDump } from "./hex"
import { readWindow, writePatch } from "./hex-io"

let dir: string
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hex-io-"))
})
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const file = (name: string) => path.join(dir, name)

describe("readWindow", () => {
  test("reads a window at an offset without the rest of the file", async () => {
    const p = file("window.bin")
    const data = new Uint8Array(1000).map((_, i) => i & 0xff)
    await fs.writeFile(p, data)
    const window = await readWindow(p, 256, 16)
    expect(window.size).toBe(1000)
    expect([...window.bytes]).toEqual([...data.subarray(256, 272)])
  })
  test("clamps a window that runs past EOF", async () => {
    const p = file("clamp.bin")
    await fs.writeFile(p, new Uint8Array([1, 2, 3, 4]))
    const window = await readWindow(p, 2, 100)
    expect([...window.bytes]).toEqual([3, 4])
  })
  test("offset at EOF reads zero bytes; offset past EOF throws legibly", async () => {
    const p = file("eof.bin")
    await fs.writeFile(p, new Uint8Array([1, 2, 3]))
    expect((await readWindow(p, 3, 8)).bytes.length).toBe(0)
    await expect(readWindow(p, 4, 8)).rejects.toThrow("beyond the end")
  })
})

describe("writePatch", () => {
  test("patches bytes in place without truncating the rest", async () => {
    const p = file("patch.bin")
    await fs.writeFile(p, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))
    const result = await writePatch(p, 2, new Uint8Array([0xaa, 0xbb]))
    expect(result).toMatchObject({ bytesWritten: 2, size: 8, created: false })
    expect([...(await fs.readFile(p))]).toEqual([0, 1, 0xaa, 0xbb, 4, 5, 6, 7])
  })
  test("writing AT the size appends", async () => {
    const p = file("append.bin")
    await fs.writeFile(p, new Uint8Array([1, 2]))
    const result = await writePatch(p, 2, new Uint8Array([3, 4]))
    expect(result.size).toBe(4)
    expect([...(await fs.readFile(p))]).toEqual([1, 2, 3, 4])
  })
  test("offset past EOF throws legibly", async () => {
    const p = file("hole.bin")
    await fs.writeFile(p, new Uint8Array([1]))
    await expect(writePatch(p, 5, new Uint8Array([9]))).rejects.toThrow("past the end")
  })
  test("creates a missing file only at offset 0", async () => {
    const p = file("created.bin")
    const result = await writePatch(p, 0, new Uint8Array([0x4d, 0x5a]))
    expect(result).toMatchObject({ bytesWritten: 2, size: 2, created: true })
    await expect(writePatch(file("missing.bin"), 4, new Uint8Array([1]))).rejects.toThrow("offset 0")
  })
})

describe("dump -> parse -> patch round-trip", () => {
  test("read-hex output written back via write-hex reproduces the bytes", async () => {
    const p = file("roundtrip.bin")
    const original = new Uint8Array(64).map((_, i) => (i * 73 + 5) & 0xff)
    await fs.writeFile(p, original)
    const window = await readWindow(p, 16, 32)
    const dumped = hexDump(window.bytes, 16)
    const q = file("roundtrip-copy.bin")
    await writePatch(q, 0, parseHexInput(dumped))
    expect([...(await fs.readFile(q))]).toEqual([...original.subarray(16, 48)])
  })
})
