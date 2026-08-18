import { expect, test } from "bun:test"
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

test("ships the portable Windows build as a 7z, and keeps macOS on zip", async () => {
  const module = await import(`./electron-builder.config.ts?archive=${Date.now()}`)
  const config = module.default as Configuration

  // The user-facing Windows download. `dir` + a hand-rolled zip in build-desktop-release.bat is what
  // this replaced, so the format was previously pinned by nothing at all.
  expect(config.win?.target).toEqual(["7z"])
  expect(config.win?.artifactName).toBe("NovaClaw-${version}-windows-${arch}.${ext}")

  // NOT symmetry — a constraint. Squirrel.Mac unpacks ZIP only, so the macOS updater feed cannot be
  // served a 7z. If this ever has to change, autoupdate on macOS changes with it.
  expect(config.mac?.target).toEqual(["dmg", "zip"])
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

test("🔴 ships the DHT sidecar, which the desktop package did not carry at all", async () => {
  const module = await import(`./electron-builder.config.ts?dht=${Date.now()}`)
  const config = module.default as Configuration

  /**
   * Review 1.7. `extraResources` had no `dht` entry, `prebuild` never built it, and
   * `community/dht.ts` had no `resourcesPath` candidate to find it with — so the DHT existed in the
   * dev tree and in the CLI build, and not on the product's primary face. A desktop user's discovery
   * fell back to the LAN and typed addresses, which is indistinguishable from a public DHT that
   * nobody is on.
   *
   * ⚠️ `build/`, not `target/release/`: cargo's scratch tree is hundreds of megabytes.
   */
  expect(config.extraResources).toContainEqual({ from: "../dht/build/", to: "dht/" })
})
