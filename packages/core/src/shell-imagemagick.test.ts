import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Shell } from "./shell"

/**
 * THE EMBEDDED `magick` MUST BE REACHABLE (owner, 2026-08-23).
 *
 * 🔴 Shipping the binary is the easy half. The half that has failed before in this codebase is the
 * OTHER one: a capability that exists on disk, is never put on the agent's PATH, is never named in
 * the prompt, and therefore is never used — *a feature can be built, tested and never called*. So
 * these tests are about the WIRING, not about ImageMagick.
 */

const saved = {
  magick: process.env["NOVACLAW_IMAGEMAGICK_PATH"],
  kit: process.env["NOVACLAW_W64DEVKIT_PATH"],
}

async function tmpdir(prefix: string) {
  return await fs.mkdtemp(path.join(os.tmpdir(), `novaclaw-${prefix}`))
}

const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name)

async function fakeMagick(complete = true) {
  const root = path.join(await tmpdir("imagemagick-"), "imagemagick")
  await fs.mkdir(root, { recursive: true })
  if (complete) await fs.writeFile(path.join(root, exe("magick")), "fake")
  await fs.writeFile(path.join(root, "configure.xml"), "<configuremap/>")
  return root
}

async function fakeKit() {
  const root = path.join(await tmpdir("w64devkit-"), "w64devkit")
  await fs.mkdir(path.join(root, "bin"), { recursive: true })
  await fs.writeFile(path.join(root, "bin", "sh.exe"), "fake")
  await fs.writeFile(path.join(root, "bin", "gcc.exe"), "fake")
  await fs.writeFile(path.join(root, "VERSION.txt"), "2.9.0\n")
  return root
}

beforeEach(() => {
  delete process.env["NOVACLAW_IMAGEMAGICK_PATH"]
})

afterEach(() => {
  if (saved.magick === undefined) delete process.env["NOVACLAW_IMAGEMAGICK_PATH"]
  else process.env["NOVACLAW_IMAGEMAGICK_PATH"] = saved.magick
  if (saved.kit === undefined) delete process.env["NOVACLAW_W64DEVKIT_PATH"]
  else process.env["NOVACLAW_W64DEVKIT_PATH"] = saved.kit
})

describe("finding the embedded ImageMagick", () => {
  test("resolves when the binary is really there", async () => {
    const root = await fakeMagick()
    process.env["NOVACLAW_IMAGEMAGICK_PATH"] = root
    expect(Shell.imagemagickRoot()).toBe(root)
    expect(Shell.imagemagick()).toBe(path.join(root, exe("magick")))
  })

  test("an incomplete Windows image toolchain is an installation error", async () => {
    const root = await fakeMagick(false)
    process.env["NOVACLAW_IMAGEMAGICK_PATH"] = root
    if (process.platform === "win32") {
      expect(() => Shell.imagemagickRoot()).toThrow(/bundled ImageMagick/)
      expect(() => Shell.imagemagick()).toThrow(/bundled ImageMagick/)
    } else {
      expect(Shell.imagemagickRoot()).toBeUndefined()
      expect(Shell.imagemagick()).toBeUndefined()
    }
    process.env["NOVACLAW_IMAGEMAGICK_PATH"] = path.join(root, "nope")
    if (process.platform === "win32") expect(() => Shell.imagemagickRoot()).toThrow(/bundled ImageMagick/)
    else expect(Shell.imagemagickRoot()).toBeUndefined()
  })

  test("a missing Windows image toolchain cannot fall back to a host copy", () => {
    process.env["NOVACLAW_IMAGEMAGICK_PATH"] = path.join(os.tmpdir(), `novaclaw-absent-magick-${process.pid}`)
    if (process.platform === "win32") expect(() => Shell.imagemagickRoot()).toThrow(/bundled ImageMagick/)
    else expect(Shell.imagemagickRoot()).toBeUndefined()
  })
})

describe("the agent's child environment", () => {
  test("🔴 magick lands on PATH, with MAGICK_HOME beside it", async () => {
    if (process.platform !== "win32") return
    const kit = await fakeKit()
    const magick = await fakeMagick()
    process.env["NOVACLAW_W64DEVKIT_PATH"] = kit
    process.env["NOVACLAW_IMAGEMAGICK_PATH"] = magick
    const env = Shell.toolchainEnv(path.join(kit, "bin", "sh.exe"), { Path: "C:\\Windows" })
    const paths = env?.["PATH"]?.split(path.delimiter)
    expect(paths).toContain(magick)
    // ⚠️ MAGICK_HOME is how `magick` finds its own configure/delegates/policy XML. Without it the
    // binary starts and silently loses colour-name lookup, format delegates, and the security policy
    // that bounds what an agent's invocation may touch.
    expect(env?.["MAGICK_HOME"]).toBe(magick)
    expect(env?.["MAGICK_CONFIGURE_PATH"]).toBe(magick)
  })

  test("bundled ImageMagick follows the kit and precedes host PATH", async () => {
    if (process.platform !== "win32") return
    const kit = await fakeKit()
    const magick = await fakeMagick()
    process.env["NOVACLAW_W64DEVKIT_PATH"] = kit
    process.env["NOVACLAW_IMAGEMAGICK_PATH"] = magick
    const paths = Shell.toolchainEnv(path.join(kit, "bin", "sh.exe"), { Path: "C:\\Windows" })?.["PATH"]?.split(
      path.delimiter,
    )
    expect(paths?.[0]).toBe(path.join(kit, "bin"))
    expect(paths?.at(-2)).toBe(magick)
    expect(paths?.at(-1)).toBe("C:\\Windows")
  })

  test("an incomplete Windows bundle cannot create a host-dependent shell environment", async () => {
    if (process.platform !== "win32") return
    const kit = await fakeKit()
    process.env["NOVACLAW_W64DEVKIT_PATH"] = kit
    process.env["NOVACLAW_IMAGEMAGICK_PATH"] = path.join(kit, "absent-magick")
    expect(() => Shell.toolchainEnv(path.join(kit, "bin", "sh.exe"), { Path: "C:\\Windows" })).toThrow(
      /bundled ImageMagick/,
    )
    process.env["NOVACLAW_W64DEVKIT_PATH"] = path.join(kit, "absent-kit")
    expect(() => Shell.toolchainEnv(path.join(kit, "bin", "sh.exe"))).toThrow(/bundled w64devkit/)
  })
})
