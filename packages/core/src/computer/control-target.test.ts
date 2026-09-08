import { describe, expect, test } from "bun:test"
import { ComputerControlTarget } from "./control-target"

describe("P6 real-desktop control targets", () => {
  test("a native Windows HWND/PID/executable grant round-trips", () => {
    const encoded = ComputerControlTarget.encodeWindowsWindow({
      windowHandle: "1844674407370955",
      processID: 980,
      executable: "chrome.exe",
    })
    expect(ComputerControlTarget.parse(encoded)).toEqual({
      ok: true,
      target: {
        kind: "windows-window",
        windowHandle: "1844674407370955",
        processID: 980,
        executable: "chrome.exe",
      },
    })
    expect(ComputerControlTarget.parse("windows-window:12:980:C%3A%5Cchrome.exe").ok).toBe(false)
  })
  const source = { display: ":0", windowID: "8388611", processID: 83, wmClass: "Chromium / Stable" }

  test("the human grant round-trips without delimiter ambiguity", () => {
    const encoded = ComputerControlTarget.encodeWindow(source)
    expect(encoded).toBe("x11-window:%3A0:8388611:83:Chromium%20%2F%20Stable")
    expect(ComputerControlTarget.parse(encoded)).toEqual({ ok: true, target: { kind: "x11-window", ...source } })
  })

  test("a plain display never silently becomes a real-desktop grant", () => {
    const parsed = ComputerControlTarget.parse(":0")
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toContain("plain display is never accepted")
  })

  test("an explicit sandbox binding remains available without real-desktop authority", () => {
    const encoded = ComputerControlTarget.encodeSandbox(":99")
    expect(encoded).toBe("x11-sandbox:%3A99")
    expect(ComputerControlTarget.parse(encoded)).toEqual({
      ok: true,
      target: { kind: "sandbox-x11", display: ":99" },
    })
  })

  test("window and process ids are bounded and positive", () => {
    for (const binding of [
      "x11-window:%3A0:0:83:Chromium",
      "x11-window:%3A0:4294967296:83:Chromium",
      "x11-window:%3A0:1:0:Chromium",
      "x11-window:%3A0:1:1:",
    ])
      expect(ComputerControlTarget.parse(binding).ok).toBe(false)
  })

  test("the measured X11 identity outputs decode and malformed output does not", () => {
    expect(ComputerControlTarget.parseWindowPID("83\n")).toBe(83)
    expect(ComputerControlTarget.parseWindowPID("not-a-pid")).toBeUndefined()
    expect(ComputerControlTarget.parseWmClass('WM_CLASS(STRING) = "chromium (/tmp/cuprofile)", "Chromium"\n')).toBe(
      "Chromium",
    )
    expect(ComputerControlTarget.parseWmClass("WM_CLASS:  not found.")).toBeUndefined()
    expect(ComputerControlTarget.parseWindowID("8388611\n")).toBe("8388611")
    expect(ComputerControlTarget.parseWindowID("0x800003\n")).toBe("8388611")
    expect(ComputerControlTarget.parseWindowID("0\n")).toBeUndefined()
    expect(
      ComputerControlTarget.verifyWindowIdentity(
        { kind: "x11-window", ...source },
        "83\n",
        'WM_CLASS(STRING) = "chromium", "Chromium / Stable"\n',
      ),
    ).toEqual({ ok: true })
    expect(
      ComputerControlTarget.verifyWindowIdentity(
        { kind: "x11-window", ...source },
        "84\n",
        'WM_CLASS(STRING) = "chromium", "Chromium / Stable"\n',
      ),
    ).toEqual({ ok: false, actualPID: 84, actualClass: "Chromium / Stable" })
  })

  test("a selected window-manager frame exposes its client descendants", () => {
    const tree = `
xwininfo: Window id: 0x200146 (has no name)
  Root window id: 0x21f
  Parent window id: 0x21f
     2 children:
     0x800003 "NovaClaw substrate check - Chromium"
     0x200147 (has no name)
        1 child:
        0x200148 (has no name)
`
    expect(ComputerControlTarget.parseWindowTree(tree)).toEqual(["2097478", "543", "8388611", "2097479", "2097480"])
    expect(ComputerControlTarget.parseRootWindowID(tree)).toBe("543")
    expect(
      ComputerControlTarget.resolveSelectedClient(
        "2097478",
        tree,
        "_NET_CLIENT_LIST(WINDOW): window id # 0x600026, 0x800003",
      ),
    ).toEqual({ ok: true, windowID: "8388611" })
    expect(
      ComputerControlTarget.resolveSelectedClient(
        "543",
        tree.replace("0x200146", "0x21f"),
        "_NET_CLIENT_LIST(WINDOW): window id # 0x800003",
      ),
    ).toEqual({ ok: false, reason: "the desktop background was selected; click the application window itself" })
  })

  test("permission resources are exact to the selected application window", () => {
    const target = ComputerControlTarget.parse(ComputerControlTarget.encodeWindow(source))
    if (!target.ok) throw new Error(target.reason)
    expect(ComputerControlTarget.permissionResource(target.target, "click")).toBe(
      "x11-window/Chromium%20%2F%20Stable/83/8388611/click",
    )
    expect(ComputerControlTarget.permissionResource(ComputerControlTarget.sandbox(":99"), "click")).toBe("click")
    expect(ComputerControlTarget.xWindowArg("8388611")).toBe("0x800003")
  })

  test("OFF-C disables the real desktop without disabling the sandbox", () => {
    expect(ComputerControlTarget.offlineRealDesktopRefusal(true)).toContain("offline/airgap")
    expect(ComputerControlTarget.offlineRealDesktopRefusal(false)).toBeUndefined()
  })
})
