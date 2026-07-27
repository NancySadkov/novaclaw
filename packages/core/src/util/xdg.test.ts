import { describe, expect, test } from "bun:test"
import path from "path"

import { Xdg } from "./xdg"

// The regression these guard is the one that shipped in v0.1.0: `os.homedir()` came back EMPTY inside
// Electron's packaged utilityProcess, xdg-basedir therefore exported `undefined`, and a `!` assertion
// turned that into the literal path "undefined\novaclaw". Clicking the home prompt bar then created a
// session at "undefined\novaclaw\scratch" and the server answered 500 with nothing in any log.
//
// It never reproduced in development because Git Bash exports HOME — so the empty-homedir case below
// is the single most important assertion in this file.

describe("Xdg.resolveHome", () => {
  test("prefers os.homedir() when it answers", () => {
    expect(Xdg.resolveHome({ USERPROFILE: "C:\\other" }, "C:\\Users\\real")).toBe("C:\\Users\\real")
  })

  test("falls back to USERPROFILE when os.homedir() is EMPTY — the packaged-Electron case", () => {
    expect(Xdg.resolveHome({ USERPROFILE: "C:\\Users\\nangl" }, "")).toBe("C:\\Users\\nangl")
    expect(Xdg.resolveHome({ USERPROFILE: "C:\\Users\\nangl" }, undefined)).toBe("C:\\Users\\nangl")
  })

  test("falls back to HOMEDRIVE + HOMEPATH, the Windows-native pair", () => {
    expect(Xdg.resolveHome({ HOMEDRIVE: "C:", HOMEPATH: "\\Users\\nangl" }, "")).toBe(path.join("C:", "\\Users\\nangl"))
    // Only one half present is not usable and must not produce a partial path.
    expect(Xdg.resolveHome({ HOMEDRIVE: "C:" }, "")).toBeUndefined()
  })

  test("falls back to HOME last — which is why Git Bash hid the bug", () => {
    expect(Xdg.resolveHome({ HOME: "/c/Users/nangl" }, "")).toBe("/c/Users/nangl")
  })

  test("NOVACLAW_TEST_HOME wins over everything, so the test preload keeps working", () => {
    expect(Xdg.resolveHome({ NOVACLAW_TEST_HOME: "/tmp/t", HOME: "/h" }, "C:\\real")).toBe("/tmp/t")
  })

  test("whitespace-only values are treated as absent, not as a home directory", () => {
    expect(Xdg.resolveHome({ HOME: "   " }, "  ")).toBeUndefined()
  })

  test("returns undefined when the platform offers nothing", () => {
    expect(Xdg.resolveHome({}, undefined)).toBeUndefined()
  })
})

describe("Xdg.baseDir", () => {
  test("the env var wins when set", () => {
    expect(Xdg.baseDir({ XDG_DATA_HOME: "D:\\xdg" }, "C:\\Users\\n", "XDG_DATA_HOME", ".local", "share")).toBe("D:\\xdg")
  })

  test("otherwise the XDG default under $HOME — the layout existing installs already use", () => {
    expect(Xdg.baseDir({}, "C:\\Users\\n", "XDG_DATA_HOME", ".local", "share")).toBe(
      path.join("C:\\Users\\n", ".local", "share"),
    )
    expect(Xdg.baseDir({}, "C:\\Users\\n", "XDG_CONFIG_HOME", ".config")).toBe(path.join("C:\\Users\\n", ".config"))
    expect(Xdg.baseDir({}, "C:\\Users\\n", "XDG_STATE_HOME", ".local", "state")).toBe(
      path.join("C:\\Users\\n", ".local", "state"),
    )
    expect(Xdg.baseDir({}, "C:\\Users\\n", "XDG_CACHE_HOME", ".cache")).toBe(path.join("C:\\Users\\n", ".cache"))
  })

  test("returns undefined instead of a path built from nothing", () => {
    // The whole defect in one assertion: this used to yield "undefined/.local/share".
    const resolved = Xdg.baseDir({}, "", "XDG_DATA_HOME", ".local", "share")
    expect(resolved).toBeUndefined()
    expect(String(resolved)).not.toContain("undefined/")
  })

  test("an empty env var is ignored in favour of $HOME", () => {
    expect(Xdg.baseDir({ XDG_DATA_HOME: "" }, "C:\\Users\\n", "XDG_DATA_HOME", ".local", "share")).toBe(
      path.join("C:\\Users\\n", ".local", "share"),
    )
  })

  test('an env var poisoned with the STRING "undefined" is ignored — the v0.1.0 bug', () => {
    // Object.assign(process.env, {K: undefined}) writes this. It is non-empty, so every ??/|| downstream
    // used to accept it, which is how the data dir became "undefined\novaclaw".
    expect(Xdg.baseDir({ XDG_DATA_HOME: "undefined" }, "C:\\Users\\n", "XDG_DATA_HOME", ".local", "share")).toBe(
      path.join("C:\\Users\\n", ".local", "share"),
    )
    expect(Xdg.resolveHome({ HOME: "undefined" }, "")).toBeUndefined()
    // The whole original symptom, asserted directly.
    const dirs = Xdg.baseDirs([], { XDG_DATA_HOME: "undefined" }, "C:\\Users\\n", "novaclaw")
    expect(dirs?.data).not.toContain("undefined")
  })
})

describe("Xdg.homeOverride", () => {
  test("reads --home <dir> and --home=<dir>", () => {
    expect(Xdg.homeOverride(["serve", "--home", "D:\\inst-a"], {})).toBe("D:\\inst-a")
    expect(Xdg.homeOverride(["serve", "--home=D:\\inst-b"], {})).toBe("D:\\inst-b")
    expect(Xdg.homeOverride(["serve", "--home-dir", "D:\\inst-c"], {})).toBe("D:\\inst-c")
  })

  test("a --home with no value does not swallow the next flag as a directory", () => {
    expect(Xdg.homeOverride(["serve", "--home", "--port", "4096"], {})).toBeUndefined()
    expect(Xdg.homeOverride(["serve", "--home"], {})).toBeUndefined()
  })

  test("the command line beats NOVACLAW_HOME, which beats nothing", () => {
    expect(Xdg.homeOverride(["--home", "D:\\cli"], { NOVACLAW_HOME: "D:\\env" })).toBe("D:\\cli")
    expect(Xdg.homeOverride([], { NOVACLAW_HOME: "D:\\env" })).toBe("D:\\env")
    expect(Xdg.homeOverride([], {})).toBeUndefined()
  })

  test("paths containing spaces survive (one argv entry, not re-split)", () => {
    expect(Xdg.homeOverride(["--home", "D:\\My Instances\\one"], {})).toBe("D:\\My Instances\\one")
  })
})

describe("Xdg.baseDirs", () => {
  test("an explicit home puts everything in ONE self-contained folder", () => {
    const d = Xdg.baseDirs(["--home", path.resolve("D:\\inst-a")], {}, "C:\\Users\\n", "novaclaw")!
    const root = path.resolve("D:\\inst-a")
    expect(d.data).toBe(path.join(root, "data"))
    expect(d.config).toBe(path.join(root, "config"))
    expect(d.state).toBe(path.join(root, "state"))
    expect(d.cache).toBe(path.join(root, "cache"))
    expect(d.explicitHome).toBe(root)
    // No stray app segment: the pinned folder IS the instance.
    expect(d.data).not.toContain(path.join("novaclaw", "data"))
  })

  test("two different --home values share NOTHING — the multi-instance guarantee", () => {
    const a = Xdg.baseDirs(["--home", path.resolve("D:\\a")], {}, "C:\\Users\\n", "novaclaw")!
    const b = Xdg.baseDirs(["--home", path.resolve("D:\\b")], {}, "C:\\Users\\n", "novaclaw")!
    for (const key of ["data", "cache", "config", "state"] as const) expect(a[key]).not.toBe(b[key])
  })

  test("without an override the XDG layout is byte-identical to before, so existing installs keep their files", () => {
    const d = Xdg.baseDirs([], {}, "C:\\Users\\n", "novaclaw")!
    expect(d.data).toBe(path.join("C:\\Users\\n", ".local", "share", "novaclaw"))
    expect(d.config).toBe(path.join("C:\\Users\\n", ".config", "novaclaw"))
    expect(d.state).toBe(path.join("C:\\Users\\n", ".local", "state", "novaclaw"))
    expect(d.cache).toBe(path.join("C:\\Users\\n", ".cache", "novaclaw"))
    expect(d.explicitHome).toBeUndefined()
  })

  test("returns undefined when nothing resolves — the caller falls back and warns", () => {
    expect(Xdg.baseDirs([], {}, "", "novaclaw")).toBeUndefined()
  })

  test("an explicit home works even when the platform exposes no home at all", () => {
    // The escape hatch the warning points at must not itself depend on a resolvable homedir.
    const d = Xdg.baseDirs(["--home", path.resolve("D:\\rescue")], {}, "", "novaclaw")
    expect(d?.data).toBe(path.join(path.resolve("D:\\rescue"), "data"))
  })
})

describe("Xdg.isSuspect", () => {
  test("catches the exact string that shipped", () => {
    expect(Xdg.isSuspect(path.join("undefined", "novaclaw"))).toBe(true)
    expect(Xdg.isSuspect("undefined\\novaclaw\\scratch")).toBe(true)
    expect(Xdg.isSuspect("undefined/novaclaw/scratch")).toBe(true)
  })

  test("catches relative and empty paths", () => {
    expect(Xdg.isSuspect("")).toBe(true)
    expect(Xdg.isSuspect("   ")).toBe(true)
    expect(Xdg.isSuspect("novaclaw/data")).toBe(true)
  })

  test("accepts real absolute paths, and does not false-positive on a substring", () => {
    expect(Xdg.isSuspect("C:\\Users\\nangl\\.local\\share\\novaclaw")).toBe(false)
    // "undefined" as part of a longer segment is a legitimate directory name.
    expect(Xdg.isSuspect("C:\\Users\\nangl\\undefined-behaviour\\novaclaw")).toBe(false)
  })
})
