import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import { join } from "node:path"
import { dhtArtifactRequired } from "./scripts/dht-packaging"
import { sanitizeBuildOutput } from "./scripts/sanitize-build-output"
import type { Configuration } from "electron-builder"

const channels = [
  { channel: "dev", appId: "app.novaclaw.desktop.dev", packageName: "novaclaw-dev" },
  { channel: "beta", appId: "app.novaclaw.desktop.beta", packageName: "novaclaw-beta" },
  { channel: "prod", appId: "app.novaclaw.desktop", packageName: "novaclaw" },
] as const

for (const channel of channels) {
  test(`uses one Linux desktop identity for ${channel.channel}`, async () => {
    const previous = process.env.NOVACLAW_CHANNEL
    process.env.NOVACLAW_CHANNEL = channel.channel

    const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
    const config = module.default as Configuration

    if (previous === undefined) delete process.env.NOVACLAW_CHANNEL
    else process.env.NOVACLAW_CHANNEL = previous

    expect(config.appId).toBe(channel.appId)
    expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`)
    expect(config.linux?.executableName).toBe(channel.appId)
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
    // Linux distribution packages. `pacman` is the Arch/CachyOS target; its depends list is Electron's
    // own runtime requirements, so a missing entry means the app installs and then fails to launch.
    expect(config.linux?.target).toEqual(["AppImage", "deb", "rpm", "pacman"])
    expect(config.pacman?.packageName).toBe(channel.packageName)
    expect(config.pacman?.compression).toBe("zstd")
    expect(config.pacman?.depends).toEqual([
      "gtk3",
      "libnotify",
      "nss",
      "libxss",
      "libxtst",
      "xdg-utils",
      "at-spi2-core",
      "libsecret",
    ])
  })
}

test("ships local archives without updater-only formats", async () => {
  const module = await import(`./electron-builder.config.ts?archive=${Date.now()}`)
  const config = module.default as Configuration

  // The user-facing Windows download. `dir` + a hand-rolled zip in the old release wrapper is what
  // this replaced, so the format was previously pinned by nothing at all.
  expect(config.win?.target).toEqual(["7z"])
  expect(config.win?.artifactName).toBe("NovaClaw-${version}-windows-${arch}.${ext}")

  expect(config.mac?.target).toEqual(["dmg"])
})

test("does not carry an updater runtime dependency", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>
  }
  const dependency = ["electron", "updater"].join("-")
  expect(pkg.dependencies?.[dependency]).toBeUndefined()
})

test("copies the server producer's complete output instead of an asset allow-list", async () => {
  const config = await Bun.file(join(import.meta.dir, "electron.vite.config.ts")).text()
  expect(config).toContain("await copyServerRuntime(NOVACLAW_SERVER_DIST, output)")
  expect(config).not.toContain("name.endsWith")
})

test("embeds the prepared w64devkit tree in Windows packages", async () => {
  const module = await import(`./electron-builder.config.ts?resource=${Date.now()}`)
  const config = module.default as Configuration
  if (process.platform !== "win32")
    return expect(config.extraResources).not.toContainEqual(expect.objectContaining({ to: "third-party/w64devkit/" }))
  expect(config.extraResources).toContainEqual({
    from: "resources/third-party/w64devkit/",
    to: "third-party/w64devkit/",
  })
  expect(config.files).toContain("!resources/third-party/**")
})

test("embeds the locally staged ripgrep binary in Windows packages", async () => {
  const module = await import(`./electron-builder.config.ts?ripgrep=${Date.now()}`)
  const config = module.default as Configuration
  if (process.platform !== "win32")
    return expect(config.extraResources).not.toContainEqual(expect.objectContaining({ to: "third-party/ripgrep/" }))
  expect(config.extraResources).toContainEqual({
    from: "resources/third-party/ripgrep/",
    to: "third-party/ripgrep/",
  })
})

test("🔴 ships the DHT sidecar, which the desktop package did not carry at all", async () => {
  const module = await import(`./electron-builder.config.ts?dht=${Date.now()}`)
  const config = module.default as Configuration

  /**
   * Review finding 1.7. `extraResources` had no `dht` entry, `prebuild` never built it, and
   * `community/dht.ts` had no `resourcesPath` candidate to find it with — so the DHT existed in the
   * dev tree and in the CLI build, and not on the product's primary face. A desktop user's discovery
   * fell back to the LAN and typed addresses, which is indistinguishable from a public DHT that
   * nobody is on.
   *
   * ⚠️ `build/`, not `target/release/`: cargo's scratch tree is hundreds of megabytes.
   */
  expect(config.extraResources).toContainEqual({ from: "../dht/build/", to: "dht/" })
  expect(typeof config.beforePack).toBe("function")
  expect(dhtArtifactRequired("dev")).toBe(false)
  expect(dhtArtifactRequired("beta")).toBe(true)
  expect(dhtArtifactRequired("prod")).toBe(true)
})

test("ships the watchdog, which nothing launches yet — the binary must exist BEFORE it is adopted", async () => {
  const module = await import(`./electron-builder.config.ts?watchdog=${Date.now()}`)
  const config = module.default as Configuration

  /**
   * 🔴 **The same shape as the DHT finding above, caught one step earlier.** That sidecar existed in
   * the dev tree and in the CLI build and was absent from the product's primary face for as long as
   * nobody wrote this assertion. The watchdog is at the point the DHT was at then: built, tested,
   * and packaged by nothing.
   *
   * ⚠️ **It degrades more quietly than the DHT does.** A missing DHT shows up the first time an
   * instance discovers nobody. A missing watchdog shows up only when something crashes — which is
   * precisely when nobody is watching the build log — so the build log is the only place it can be
   * caught, and this assertion is the only place the PACKAGE can.
   *
   * ⚠️ Nothing SPAWNS it yet, on purpose: adoption puts three supervision layers in a line and is a
   * decision to take deliberately. Packaging it is not that decision. It costs
   * 220 KB, and a build step nobody has ever run is the one that fails on the day it is needed.
   *
   * ⚠️ `build/`, not `target/release/`: cargo's scratch tree is hundreds of megabytes.
   */
  expect(config.extraResources).toContainEqual({ from: "../watchdog/build/", to: "watchdog/" })
})

test("clears watchdog staging before the optional Cargo decision", () => {
  const source = readFileSync(join(import.meta.dir, "..", "watchdog", "build.ts"), "utf8")
  const clearStaging = source.indexOf("rmSync(staging, { recursive: true, force: true })")
  const createStaging = source.indexOf("mkdirSync(staging, { recursive: true })")
  const clearCargoOutput = source.indexOf("rmSync(built, { force: true })")
  const findCargo = source.indexOf('Bun.which("cargo")')

  expect(clearStaging).toBeGreaterThan(-1)
  expect(createStaging).toBeGreaterThan(clearStaging)
  expect(clearCargoOutput).toBeGreaterThan(createStaging)
  expect(findCargo).toBeGreaterThan(clearCargoOutput)
})

test("all channels package locally without a remote publisher or signing callback", async () => {
  const previous = process.env.NOVACLAW_CHANNEL
  try {
    for (const { channel } of channels) {
      process.env.NOVACLAW_CHANNEL = channel
      const module = await import(`./electron-builder.config.ts?local-package=${channel}`)
      const config = module.default as Configuration

      expect(config.publish).toBeUndefined()
      expect(config.win?.signtoolOptions).toBeUndefined()
    }
  } finally {
    if (previous === undefined) delete process.env.NOVACLAW_CHANNEL
    else process.env.NOVACLAW_CHANNEL = previous
  }
})

test("workspace TypeScript is bundled instead of shipped as a runtime dependency", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }

  expect(pkg.dependencies?.["@novaclaw/schema"]).toBeUndefined()
  expect(pkg.devDependencies?.["@novaclaw/schema"]).toBe("workspace:*")
})

test("normal builds scrub retired vendor markers from emitted text", async () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8")) as {
    scripts?: Record<string, string>
  }
  expect(pkg.scripts?.postbuild).toBe("bun ./scripts/sanitize-build-output.ts")

  const directory = await mkdtemp(join(os.tmpdir(), "novaclaw-output-sanitize-"))
  const file = join(directory, "bundle.js")
  const binary = join(directory, "bundle.bin")
  const signed = join(directory, "signed.exe")
  const retired = [String.fromCharCode(103, 105, 116, 104, 117, 98), String.fromCharCode(97, 122, 117, 114, 101)]
  try {
    await writeFile(file, retired.join(" "))
    await writeFile(binary, Buffer.concat([Buffer.from([0, 255, 1]), Buffer.from(retired.join(" ").toUpperCase())]))
    await writeFile(signed, retired.join(" "))
    await sanitizeBuildOutput(directory)
    const clean = readFileSync(file, "utf8")
    for (const marker of retired) expect(clean.toLowerCase()).not.toContain(marker)
    expect(clean).toBe("remote local")
    expect(await readFile(binary)).toEqual(Buffer.concat([Buffer.from([0, 255, 1]), Buffer.from("remote local")]))
    expect(await readFile(signed, "utf8")).toBe(retired.join(" "))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("packages scrub the staged application without rewriting signed native payloads", async () => {
  const module = await import(`./electron-builder.config.ts?sanitize=${Date.now()}`)
  const config = module.default as Configuration
  expect(config.afterPack).toBeFunction()
})
