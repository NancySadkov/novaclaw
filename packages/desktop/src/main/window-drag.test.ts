import { describe, expect, test } from "bun:test"
import { restoreWindowDrag, windowDragPosition, type WindowDrag } from "./window-drag"

const drag = (): WindowDrag => ({
  screenX: 100,
  screenY: 100,
  clientX: 20,
  clientY: 12,
  x: 400,
  y: 300,
  maximized: false,
})

describe("desktop window drag", () => {
  test("moves from the native cursor without renderer screen coordinates", () => {
    expect(windowDragPosition(drag(), { x: 125, y: 140 })).toEqual([425, 340])
  })

  test("anchors a restored window under the current cursor", () => {
    const state = drag()
    state.maximized = true
    restoreWindowDrag(state, { x: 600, y: 250 }, [800, 600])
    expect(windowDragPosition(state, { x: 600, y: 250 })).toEqual([580, 238])
    expect(windowDragPosition(state, { x: 630, y: 260 })).toEqual([610, 248])
  })

  test("rejects values that Electron cannot convert to native window coordinates", () => {
    const state = drag()
    expect(windowDragPosition(state, { x: Number.NaN, y: 100 })).toBeUndefined()
    expect(windowDragPosition(state, { x: 1e308, y: 100 })).toBeUndefined()
    expect(windowDragPosition(state, { x: 2147483748, y: 100 })).toBeUndefined()
  })
})
