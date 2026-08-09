import { describe, expect, test } from "bun:test"
import { ComputerAtSpi as AtSpi } from "./atspi"

describe("P5 Linux AT-SPI adapter", () => {
  test("scan and invoke are argv plans with an explicit display and no model text in code", () => {
    const scan = AtSpi.scanPlan(":99")
    expect(scan.argv.slice(0, 2)).toEqual(["python3", "-c"])
    expect(scan.env).toEqual({ DISPLAY: ":99", NO_AT_BRIDGE: "0", GTK_A11Y: "always" })
    const request = { elementID: "root/0/0/0", ownName: 'Save; __import__("os")', actionName: "click" }
    const invoke = AtSpi.invokePlan(":99", request)
    expect(invoke.argv.slice(-3)).toEqual([request.elementID, request.ownName, request.actionName])
    expect(invoke.argv[2]).not.toContain(request.ownName)
  })

  test("decodes the live GTK probe shape through the common candidate boundary", () => {
    const decoded = AtSpi.decodeScan(
      JSON.stringify([
        { id: "root", role: "desktop frame", name: "main", bounds: { x: 0, y: 0, width: 1280, height: 800 }, actions: [] },
        { id: "root/0/0/0", role: "push button", name: "Save", bounds: { x: 0, y: 0, width: 320, height: 200 }, actions: ["click"] },
      ]),
      { width: 1280, height: 800 },
    )
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.candidates.map((candidate) => candidate.name)).toEqual(["Save"])
    expect(decoded.rejected).toBe(1)
  })

  test("malformed scan output and every invocation refusal stay explicit", () => {
    expect(AtSpi.decodeScan("not json", { width: 1, height: 1 })).toEqual({
      ok: false,
      reason: expect.stringContaining("did not return JSON") as unknown as string,
    })
    expect(AtSpi.decodeInvoke(0, '{"ok":true}')).toEqual({ ok: true })
    expect(AtSpi.decodeInvoke(4, '{"ok":false,"reason":"tree changed"}')).toEqual({
      ok: false,
      reason: "tree changed",
    })
    expect(AtSpi.decodeInvoke(7, "", "bridge missing")).toEqual({
      ok: false,
      reason: "AT-SPI invocation exited 7: bridge missing",
    })
  })
})
