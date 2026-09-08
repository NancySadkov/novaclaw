import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Avatar } from "@novaclaw/core/agent/avatar"

const roots: string[] = []
const root = async () => {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "novaclaw-avatar-"))
  roots.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => fs.rm(value, { recursive: true, force: true })))
})

describe("instance-owned agent portraits", () => {
  test("resolves a bundled file-loader asset beside its emitted chunk, independent of cwd", () => {
    const chunk = path.join(path.parse(process.cwd()).root, "opt", "novaclaw", "server", "chunk.js")
    expect(Avatar.bundledAssetPath("./daedalus-hash.webp", pathToFileURL(chunk).href)).toBe(
      path.join(path.dirname(chunk), "daedalus-hash.webp"),
    )
    expect(Avatar.bundledAssetPath(path.resolve("portrait.webp"), "file:///somewhere/else/chunk.js")).toBe(
      path.resolve("portrait.webp"),
    )
  })

  test("publishes bytes and reopens the same portrait by agent identity", async () => {
    const data = await root()
    const bytes = Uint8Array.of(0x89, 0x50, 0x4e, 0x47)
    const stored = await Avatar.writeIn(data, "theron-2", bytes, "image/png")

    expect(stored.hash).toHaveLength(64)
    expect(await Avatar.readIn(data, "theron-2")).toEqual({ bytes, mime: "image/png", hash: stored.hash })
    expect((await Avatar.portraitIn(data, "theron-2", undefined, "Theron")).kind).toBe("image")
    expect(await Avatar.readIn(data, "theron")).toBeUndefined()
  })

  test("a missing portrait is a deterministic server-owned placeholder, not a client lookup", async () => {
    const data = await root()
    const first = await Avatar.portraitIn(data, "theron-2", undefined, "Theron")
    const second = await Avatar.portraitIn(data, "theron-2", undefined, "Theron")
    expect(first).toEqual(second)
    expect(first.kind).toBe("placeholder")
    if (first.kind === "placeholder") expect(new TextDecoder().decode(first.bytes)).toContain(">T</text>")
  })

  test("🔴 the initial colleagues' drawn faces come from the server-owned portrait resolver", async () => {
    const data = await root()
    for (const id of ["nova", "geryon", "xenia", "daedalus", "myron", "xenia-2"]) {
      const portrait = await Avatar.portraitIn(data, id, undefined, id)
      expect(portrait.kind, id).toBe("image")
      if (portrait.kind !== "image") throw new Error(`${id} did not resolve to its shipped portrait`)
      expect(portrait.mime, id).toBe("image/webp")
      expect([...portrait.bytes.slice(0, 4)], id).toEqual([0x52, 0x49, 0x46, 0x46])
    }
  })

  test("a configured glyph remains the one source when no image was uploaded", async () => {
    const data = await root()
    expect(await Avatar.portraitIn(data, "wren", "🦊", "Wren")).toEqual({ kind: "glyph", text: "🦊" })
  })

  test("replacing and removing do not leave old blobs behind", async () => {
    const data = await root()
    const first = await Avatar.writeIn(data, "wren", Uint8Array.of(1, 2, 3), "image/png")
    const second = await Avatar.writeIn(data, "wren", Uint8Array.of(4, 5, 6), "image/jpeg")
    expect(first.hash).not.toBe(second.hash)
    expect((await fs.readdir(Avatar.rootIn(data))).filter((entry) => !entry.endsWith(".json"))).toHaveLength(1)
    expect(await Avatar.readIn(data, "wren")).toEqual({
      bytes: Uint8Array.of(4, 5, 6),
      mime: "image/jpeg",
      hash: second.hash,
    })
    await Avatar.removeIn(data, "wren")
    expect(await Avatar.readIn(data, "wren")).toBeUndefined()
  })

  test("rejects unknown media and oversized input before writing", async () => {
    const data = await root()
    await expect(Avatar.writeIn(data, "wren", Uint8Array.of(1), "image/svg+xml")).rejects.toThrow("PNG, JPEG")
    await expect(Avatar.writeIn(data, "wren", new Uint8Array(Avatar.MAX_BYTES + 1), "image/png")).rejects.toThrow(
      "larger",
    )
    await expect(fs.stat(Avatar.rootIn(data))).rejects.toThrow()
  })
})
