import { describe, expect, test } from "bun:test"
import { ComputerActions } from "./actions"
import { ComputerControlTarget } from "./control-target"
import { WindowsComputer } from "./windows-native"

const target: ComputerControlTarget.WindowsWindow = {
  kind: "windows-window",
  windowHandle: "1844674407370955",
  processID: 42,
  executable: "dosbox-x.exe",
}
const inspection: WindowsComputer.Inspection = {
  handle: target.windowHandle,
  processID: target.processID,
  executable: target.executable,
  title: "DOSBox-X",
  visible: true,
  minimized: false,
  foreground: true,
  x: 10,
  y: 20,
  width: 1280,
  height: 800,
}

describe("native Windows computer actions", () => {
  test("parses a string HWND without losing 64-bit precision", () => {
    expect(
      WindowsComputer.parseInspection(
        JSON.stringify({
          handle: target.windowHandle,
          processID: target.processID,
          executable: target.executable,
          title: "DOSBox-X",
          visible: true,
          minimized: false,
          foreground: true,
          x: 10,
          y: 20,
          width: 1280,
          height: 800,
        }),
      ),
    ).toMatchObject({ handle: target.windowHandle, executable: "dosbox-x.exe" })
    expect(WindowsComputer.parseInspection('{"handle":1844674407370955}')).toBeUndefined()
  })

  test("bind is an argv-only executable grant", () => {
    expect(WindowsComputer.bindArgv("C:\\Temp\\nova helper.ps1", "dosbox-x.exe")).toEqual([
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\Temp\\nova helper.ps1",
      "-Operation",
      "bind",
      "-Executable",
      "dosbox-x.exe",
    ])
  })

  test("hostile typed text is base64 data and never PowerShell syntax", () => {
    const text = '"; Remove-Item -Recurse C:\\\\ #'
    const built = WindowsComputer.build({ kind: "type", text }, target, inspection, "helper.ps1", "shot.png", "normalized-1000")
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const argv = built.argv[0]!
    expect(argv).not.toContain(text)
    expect(Buffer.from(argv.at(-1)!, "base64").toString("utf8")).toBe(text)
  })

  test("a pointed click remains move then click inside the same HWND", () => {
    const built = WindowsComputer.build(
      { kind: "click", button: "left", point: { x: 12, y: 34 } },
      target,
      inspection,
      "helper.ps1",
      "shot.png",
      "normalized-1000",
    )
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.argv).toHaveLength(2)
    expect(built.argv[0]).toContain("move")
    expect(built.argv[0]).toContain(target.windowHandle)
    expect(built.argv[1]).toContain("click")
    expect(built.argv[1]).toContain(target.windowHandle)
  })

  test("a fraction is converted when the caller DECLARES a fractional space", () => {
    // ⚠️ It used to be INFERRED from the value, which is what made `x: 1` mean 1/1000 of the window
    // instead of its right edge. The space is the caller's to state; the same 0.15 under a declared
    // `normalized-1000` is now refused by name rather than silently re-read.
    const built = WindowsComputer.build(
      { kind: "move", point: { x: 0.15, y: 0.55 } },
      target,
      inspection,
      "helper.ps1",
      "shot.png",
      "normalized-1",
    )
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.argv[0]).toEqual(expect.arrayContaining(["-X", "192", "-Y", "440"]))
  })

  test("maps Holo's measured 0-1000 vision grid to the approved window", () => {
    const built = WindowsComputer.build(
      { kind: "move", point: { x: 540, y: 445 } },
      target,
      inspection,
      "helper.ps1",
      "shot.png",
      "normalized-1000",
    )
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.argv[0]).toEqual(expect.arrayContaining(["-X", "691", "-Y", "356"]))
  })

  test("identity and foreground are revalidated before every action", () => {
    const base = {
      handle: target.windowHandle,
      processID: target.processID,
      executable: target.executable,
      title: "DOSBox-X",
      visible: true,
      minimized: false,
      foreground: true,
      x: 0,
      y: 0,
      width: 1280,
      height: 800,
    }
    expect(WindowsComputer.verifyIdentity(target, base)).toEqual({ ok: true })
    expect(WindowsComputer.verifyIdentity(target, { ...base, foreground: false })).toEqual({
      ok: false,
      reason: "approved window is not the foreground application",
    })
    expect(WindowsComputer.verifyIdentity(target, { ...base, processID: 43 })).toEqual({
      ok: false,
      reason: "process changed to pid 43",
    })
  })

  test("all action kinds lower to the native helper", () => {
    const actions: ComputerActions.Action[] = [
      { kind: "screenshot" },
      { kind: "move", point: { x: 1, y: 2 } },
      { kind: "click", button: "right" },
      { kind: "double_click" },
      { kind: "type", text: "hello" },
      { kind: "type_submit", text: "hello" },
      { kind: "key", keys: "ctrl+s" },
      { kind: "copy_text" },
      { kind: "scroll", direction: "down", amount: 3 },
      { kind: "cursor" },
    ]
    for (const action of actions)
      expect(WindowsComputer.build(action, target, inspection, "helper.ps1", "shot.png", "normalized-1000").ok).toBe(true)
  })
})
