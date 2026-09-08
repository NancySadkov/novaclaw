import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  desktopProfilePaths,
  ensureDesktopProfile,
  isInsideInstanceRoot,
  resolveInstanceRoot,
} from "./instance-home-path"

describe("the desktop profile is part of the instance home", () => {
  test("the default home owns settings instead of Electron's shared AppData profile", () => {
    const root = resolveInstanceRoot([], {}, "C:\\Users\\nova", "C:\\Temp\\novaclaw-home")
    expect(root).toBe(join("C:\\Users\\nova", ".local", "share", "novaclaw"))
    expect(desktopProfilePaths(root)).toEqual({
      userData: join(root, "desktop"),
      sessionData: join(root, "desktop", "session"),
    })
  })

  test("--home and NOVACLAW_HOME move the desktop profile with the whole instance", () => {
    const cli = resolve("D:\\instances\\cli")
    const env = resolve("D:\\instances\\env")
    expect(resolveInstanceRoot(["--home", cli], { NOVACLAW_HOME: env }, undefined, "C:\\Temp\\fallback")).toBe(cli)
    expect(resolveInstanceRoot([], { NOVACLAW_HOME: env }, undefined, "C:\\Temp\\fallback")).toBe(env)
    for (const candidate of Object.values(desktopProfilePaths(cli)))
      expect(isInsideInstanceRoot(cli, candidate)).toBe(true)
  })

  test("an unavailable OS home degrades inside the supplied emergency home", () => {
    const emergency = resolve("C:\\Temp\\novaclaw-home")
    expect(resolveInstanceRoot([], {}, undefined, emergency)).toBe(emergency)
  })

  test("a dev-isolated build gets one separate home, not four redirected XDG roots", () => {
    const normal = join("C:\\Users\\nova", ".local", "share", "novaclaw")
    expect(resolveInstanceRoot([], { NOVACLAW_DEV_ISOLATED: "1" }, "C:\\Users\\nova", "C:\\Temp\\fallback")).toBe(
      `${normal}-dev`,
    )
    const explicit = resolve("D:\\instances\\chosen")
    expect(
      resolveInstanceRoot(
        ["--home", explicit],
        { NOVACLAW_DEV_ISOLATED: "1" },
        "C:\\Users\\nova",
        "C:\\Temp\\fallback",
      ),
    ).toBe(explicit)
  })

  test("an unwritable selected home relocates the complete desktop profile to the emergency home", () => {
    const made: string[] = []
    const selected = resolve("D:\\blocked")
    const emergency = resolve("C:\\Temp\\novaclaw-home")
    const result = ensureDesktopProfile(selected, emergency, (directory) => {
      if (isInsideInstanceRoot(selected, directory)) throw new Error("EACCES")
      made.push(directory)
    })
    expect(result).toEqual({
      instanceRoot: emergency,
      profile: desktopProfilePaths(emergency),
      relocated: true,
    })
    expect(made).toEqual(Object.values(desktopProfilePaths(emergency)))
  })
})

test("desktop startup has no AppData persistence escape hatch", async () => {
  const source = await Bun.file(new URL("./instance-home.ts", import.meta.url)).text()
  expect(source).toContain('app.setPath("userData", profile.userData)')
  expect(source).toContain('app.setPath("sessionData", profile.sessionData)')

  const escaped: string[] = []
  const glob = new Bun.Glob("**/*.ts")
  for await (const file of glob.scan({ cwd: import.meta.dir })) {
    if (file.endsWith(".test.ts")) continue
    if (/app\.getPath\(["']appData["']\)/.test(readFileSync(join(import.meta.dir, file), "utf8"))) escaped.push(file)
  }
  expect(escaped).toEqual([])

  const store = readFileSync(join(import.meta.dir, "store.ts"), "utf8")
  expect(store).toContain('cwd: electron.app.getPath("userData")')
})
