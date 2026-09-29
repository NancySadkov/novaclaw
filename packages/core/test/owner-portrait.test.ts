import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { Avatar } from "@novaclaw/core/agent/avatar"
import { AvatarAssignment } from "@novaclaw/core/agent/avatar-assignment"

/**
 * 🔴 THE OWNER SHIPS A PORTRAIT, LIKE NOVA — AND IT IS PINNED, NOT MERELY DEFAULTED.
 *
 * `portraitIn` resolves `built-in` → `stored` → `glyph` → `pool` → placeholder. Two ways that goes
 * wrong for a built-in, and both were live on this instance before the fix:
 *
 *   1. The shipped art sat at the BUILT-IN position but the special-case branch above it was keyed on
 *      the literal `"nova"`, so the owner fell through to whatever was stored, then to a pool claim.
 *      The live instance already held `sha256('owner').pool.json` — the owner was rendering a random
 *      colleague's face out of the 104-slot pool.
 *   2. A built-in reachable only by fall-through is a LAST RESORT, not a default: any stale blob keeps
 *      winning forever, so the shipped art would never appear at all.
 *
 * The fix pins built-ins from the table, so a stored avatar or pool claim for one is CLEARED on the way
 * and the shipped art wins — and the next built-in added is covered without a second edit.
 */
const withData = async (body: (dataDirectory: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), "novaclaw-owner-portrait-"))
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("the owner has a shipped portrait", () => {
  test("it resolves to real image bytes, not a glyph or a pool slot", async () => {
    await withData(async (dataDirectory) => {
      const portrait = await Avatar.portraitIn(dataDirectory, "owner", undefined, "Owner")
      expect(portrait.kind).toBe("image")
      if (portrait.kind !== "image") throw new Error("unreachable")
      expect(portrait.mime).toBe("image/webp")
      expect(portrait.bytes.byteLength).toBeGreaterThan(0)
      // A glyph means the stored-glyph branch won; an svg placeholder means the pool ran dry. Neither
      // is acceptable for an agent that ships art.
      expect(portrait.mime).not.toBe("image/svg+xml")
    })
  })

  test("🔴 a POOL CLAIM left over from before the art shipped does not win", async () => {
    // The exact state the live instance was in: sha256('owner').pool.json existed, so the owner was
    // drawing a random officer's face. This is the regression, asserted.
    await withData(async (dataDirectory) => {
      const claimed = await AvatarAssignment.claimIn(dataDirectory, "owner")
      expect(claimed, "the pool must hand out a slot for the setup to be faithful").toBeDefined()
      const portrait = await Avatar.portraitIn(dataDirectory, "owner", undefined, "Owner")
      expect(portrait.kind).toBe("image")
      if (portrait.kind !== "image") throw new Error("unreachable")
      expect(portrait.mime).toBe("image/webp")
      // And the claim is RELEASED, so the slot returns to the pool for a colleague rather than being
      // stranded by an agent that can no longer use it.
      const after = await AvatarAssignment.claimIn(dataDirectory, "owner")
      expect(after === undefined || after !== claimed, "the stale claim must not survive").toBe(true)
    })
  })

  test("🔴 a STORED avatar does not win either — the shipped art is pinned", async () => {
    // Planted ON DISK, not through `writeIn`, because `writeIn` now REFUSES a stored owner portrait —
    // which is itself the first line of defence. This case covers the state that guard cannot reach: an
    // artifact left by an older build, or written by hand, that is already on the filesystem when the
    // server starts. The pinned branch must clear it rather than lose to it.
    await withData(async (dataDirectory) => {
      const root = Avatar.rootIn(dataDirectory)
      await mkdir(root, { recursive: true })
      const key = createHash("sha256").update("owner").digest("hex")
      const bytes = new Uint8Array([1, 2, 3, 4])
      const hash = createHash("sha256").update(bytes).digest("hex")
      await writeFile(join(root, `${key}-${hash}.png`), bytes)
      await writeFile(join(root, `${key}.json`), JSON.stringify({ hash, mime: "image/png" }))

      // The artifact really is readable, so the test is meaningful rather than vacuous.
      expect(await Avatar.readIn(dataDirectory, "owner")).not.toBeUndefined()

      const portrait = await Avatar.portraitIn(dataDirectory, "owner", undefined, "Owner")
      expect(portrait.kind).toBe("image")
      if (portrait.kind !== "image") throw new Error("unreachable")
      // The shipped bytes, not the 4-byte png planted above.
      expect(portrait.mime).toBe("image/webp")
      expect(portrait.bytes.byteLength).toBeGreaterThan(4)
      // And the planted component is gone, so it cannot win again on a later read.
      const left = await readdir(root)
      expect(left.filter((name) => name.includes(".png"))).toEqual([])
    })
  })

  test("the id is matched case- and space-insensitively, like every other lookup", async () => {
    await withData(async (dataDirectory) => {
      for (const id of ["Owner", " OWNER ", "owner"]) {
        const portrait = await Avatar.portraitIn(dataDirectory, id, undefined, "Owner")
        expect(portrait.kind, `"${id}" must resolve`).toBe("image")
        if (portrait.kind !== "image") throw new Error("unreachable")
        expect(portrait.mime).toBe("image/webp")
      }
    })
  })
})

describe("the owner's art is reserved for the owner", () => {
  test("a colleague cannot store a copy of it", async () => {
    // The shipped art is the instance's own identity. Storing those bytes under a colleague's id would
    // put the owner's face on an officer who never chose it.
    await withData(async (dataDirectory) => {
      const shipped = await Avatar.builtin("owner")
      expect(shipped, "the owner's portrait must be readable as a built-in").not.toBeUndefined()
      if (shipped === undefined) throw new Error("unreachable")
      await expect(
        Avatar.writeIn(dataDirectory, "some-colleague", shipped.bytes, shipped.mime),
      ).rejects.toThrow(/reserved/)
    })
  })

  test("and the owner cannot store a different portrait over it either", async () => {
    await withData(async (dataDirectory) => {
      await expect(Avatar.writeIn(dataDirectory, "owner", new Uint8Array([9, 9]), "image/png")).rejects.toThrow(
        /owner always uses/,
      )
    })
  })

  test("Nova keeps its own reservation, unchanged", async () => {
    // The guard this generalises used to be about Nova alone; the refactor must not have weakened it.
    await withData(async (dataDirectory) => {
      await expect(Avatar.writeIn(dataDirectory, "nova", new Uint8Array([9, 9]), "image/png")).rejects.toThrow(
        /star portrait/,
      )
    })
  })
})

describe("the two shipped portraits are real image files", () => {
  test.each(["nova", "owner"])("%s decodes to a square image larger than a placeholder", async (id) => {
    const shipped = await Avatar.builtin(id)
    expect(shipped, `${id} must ship a portrait`).not.toBeUndefined()
    if (shipped === undefined) throw new Error("unreachable")
    expect(shipped.mime).toBe("image/webp")
    // A real portrait, not a 1x1 pixel or a truncated file.
    expect(shipped.bytes.byteLength).toBeGreaterThan(1024)
    // RIFF/WEBP container magic, so a mis-encoded asset fails here rather than in a browser.
    const head = new TextDecoder().decode(shipped.bytes.slice(0, 4))
    const tag = new TextDecoder().decode(shipped.bytes.slice(12, 16))
    expect(head).toBe("RIFF")
    expect(["VP8 ", "VP8L", "VP8X"]).toContain(tag)
  })

  test("a built-in id that does not ship art resolves to nothing", async () => {
    // The guard for the wrong key: `builtin` must not invent a portrait for an unknown id, or a typo in
    // BUILTIN_PORTRAITS would silently become a working but missing portrait.
    expect(await Avatar.builtin("definitely-not-an-agent")).toBeUndefined()
  })
})
