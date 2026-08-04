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
