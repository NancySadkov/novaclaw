import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Avatar } from "@novaclaw/core/agent/avatar"
import { AvatarAssignment } from "@novaclaw/core/agent/avatar-assignment"

const roots: string[] = []
const root = async () => {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "novaclaw-avatar-"))
  roots.push(value)
  return value
}

const webPDimensions = (bytes: Uint8Array) => {
  expect(new TextDecoder().decode(bytes.slice(12, 16))).toBe("VP8 ")
  expect([...bytes.slice(23, 26)]).toEqual([0x9d, 0x01, 0x2a])
  return {
    width: (((bytes[27] ?? 0) << 8) | (bytes[26] ?? 0)) & 0x3fff,
    height: (((bytes[29] ?? 0) << 8) | (bytes[28] ?? 0)) & 0x3fff,
  }
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

  test("an agent without an upload receives a stable server-owned pool portrait", async () => {
    const data = await root()
    const first = await Avatar.portraitIn(data, "theron-2", undefined, "Theron")
    const second = await Avatar.portraitIn(data, "theron-2", undefined, "Theron")
    expect(first).toEqual(second)
    expect(first.kind).toBe("image")

    await AvatarAssignment.retireIn(data, "theron-2")
    const retired = await Avatar.portraitIn(data, "theron-2", undefined, "Theron")
    expect(retired.kind).toBe("placeholder")
    if (retired.kind === "placeholder") expect(new TextDecoder().decode(retired.bytes)).toContain(">T</text>")
  })

  test("the bundled pool contains 104 distinct WebP portraits", async () => {
    const hashes = new Set<string>()
    for (let slot = 0; slot < AvatarAssignment.POOL_SIZE; slot++) {
      const portrait = await Avatar.pooled(slot)
      expect(portrait, `slot ${slot}`).toBeDefined()
      expect(portrait?.mime, `slot ${slot}`).toBe("image/webp")
      expect([...portrait!.bytes.slice(0, 4)], `slot ${slot}`).toEqual([0x52, 0x49, 0x46, 0x46])
      expect(webPDimensions(portrait!.bytes), `slot ${slot}`).toEqual({ width: 250, height: 250 })
      hashes.add(portrait!.hash)
    }
    expect(hashes.size).toBe(AvatarAssignment.POOL_SIZE)
  })

  test("agents receive unique stable portraits and retirement returns a slot to the pool", async () => {
    const data = await root()
    expect(await AvatarAssignment.claimIn(data, "theron", () => 0)).toBe(0)
    expect(await AvatarAssignment.claimIn(data, "wren", () => 0)).toBe(1)
    expect(await AvatarAssignment.claimIn(data, "theron", () => 0.99)).toBe(0)

    await AvatarAssignment.retireIn(data, "theron")
    expect(await AvatarAssignment.claimIn(data, "theron", () => 0)).toBeUndefined()
    expect(await AvatarAssignment.claimIn(data, "cassia", () => 0)).toBe(0)
    expect(await AvatarAssignment.activateIn(data, "theron", () => 0)).toBe(2)

    const portraits = await Promise.all(
      ["theron", "wren", "cassia"].map((id) => Avatar.portraitIn(data, id, undefined, id)),
    )
    expect(portraits.every((portrait) => portrait.kind === "image")).toBe(true)
    expect(new Set(portraits.map((portrait) => (portrait.kind === "image" ? portrait.hash : ""))).size).toBe(3)
  })

  test("Nova is the only built-in portrait and other established portraits use pool slots", async () => {
    const data = await root()
    expect(await Avatar.builtin("nova")).toBeDefined()
    for (const [slot, id] of ["geryon", "xenia", "daedalus", "myron"].entries()) {
      expect(await Avatar.builtin(id)).toBeUndefined()
      expect(await AvatarAssignment.claimIn(data, id, () => 0)).toBe(slot)
      const portrait = await Avatar.portraitIn(data, id, undefined, id)
      const pooled = await Avatar.pooled(slot)
      if (pooled === undefined) throw new Error(`Missing pool portrait at slot ${slot}`)
      expect(portrait).toEqual({ kind: "image", ...pooled })
    }
    expect(await AvatarAssignment.claimIn(data, "new-officer", () => 0)).toBe(4)
  })

  test("Nova always uses the star portrait and no other agent may upload it", async () => {
    const data = await root()
    const star = await Avatar.builtin("nova")
    expect(star).toBeDefined()
    await AvatarAssignment.claimIn(data, "nova", () => 0)

    const portrait = await Avatar.portraitIn(data, "nova", "🦊", "Renamed Nova")
    expect(portrait.kind).toBe("image")
    if (portrait.kind === "image") expect(portrait.hash).toBe(star!.hash)
    expect(await AvatarAssignment.claimIn(data, "new-officer", () => 0)).toBe(0)
    await expect(Avatar.writeIn(data, "nova", Uint8Array.of(1), "image/png")).rejects.toThrow("always uses")
    await expect(Avatar.writeIn(data, "wren", star!.bytes, "image/webp")).rejects.toThrow("reserved for Nova")
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
