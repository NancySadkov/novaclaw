import { beforeEach, describe, expect, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import { createEditorCore, type EditorCore } from "./editor-core"
import { getCursorPosition, setCursorPosition } from "./editor-dom"

const EMPTY: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]

let host: HTMLDivElement
let core: EditorCore

beforeEach(() => {
  document.body.innerHTML = ""
  host = document.createElement("div")
  host.contentEditable = "true"
  document.body.appendChild(host)
  core = createEditorCore({ editor: () => host, empty: () => EMPTY })
})

const filePill = { type: "file" as const, path: "src/a.ts", content: "@a.ts", start: 0, end: 5 }

describe("editor-core (ui-arch P4a)", () => {
  test("render → parse round-trips text, pills, and line breaks", () => {
    const parts: Prompt = [
      { type: "text", content: "look at ", start: 0, end: 8 },
      { ...filePill, start: 8, end: 13 },
      { type: "text", content: "\nplease", start: 13, end: 20 },
    ]
    core.render(parts)
    const parsed = core.parse()
    expect(parsed).toEqual(parts)
    expect(core.isNormalized()).toBe(true)
  })

  test("render pads a trailing break with a zero-width placeholder", () => {
    core.render([{ type: "text", content: "line\n", start: 0, end: 5 }])
    expect(host.lastChild?.textContent).toBe("\u200B")
    expect(core.isNormalized()).toBe(true)
    expect(core.parse()).toEqual([{ type: "text", content: "line\n", start: 0, end: 5 }])
  })

  test("parse strips zero-width characters and normalizes CRLF", () => {
    host.appendChild(document.createTextNode("a\u200Bb\r\nc"))
    expect(core.parse()).toEqual([{ type: "text", content: "ab\nc", start: 0, end: 4 }])
  })

  test("parse of an empty editor returns the provided empty prompt", () => {
    expect(core.parse()).toEqual(EMPTY)
  })

  test("parse treats block wrappers as line breaks (browser paste shape)", () => {
    const div1 = document.createElement("div")
    div1.textContent = "one"
    const div2 = document.createElement("div")
    div2.textContent = "two"
    host.appendChild(div1)
    host.appendChild(div2)
    expect(core.parse()).toEqual([{ type: "text", content: "one\ntwo", start: 0, end: 7 }])
  })

  test("isNormalized rejects stray zero-width runs and unknown elements", () => {
    host.appendChild(document.createTextNode("a\u200Bb"))
    expect(core.isNormalized()).toBe(false)
    host.innerHTML = ""
    host.appendChild(document.createElement("div"))
    expect(core.isNormalized()).toBe(false)
  })

  test("createPill stamps type metadata and is non-editable", () => {
    const pill = core.createPill(filePill)
    expect(pill.dataset.type).toBe("file")
    expect(pill.dataset.path).toBe("src/a.ts")
    expect(pill.textContent).toBe("@a.ts")
    expect(pill.getAttribute("contenteditable")).toBe("false")
  })

  test("placeCursorAtEnd focuses and lands the caret after all content", () => {
    core.render([{ type: "text", content: "hello", start: 0, end: 5 }])
    core.placeCursorAtEnd()
    expect(getCursorPosition(host)).toBe(5)
  })

  test("focusAt restores a specific cursor position", () => {
    core.render([{ type: "text", content: "hello", start: 0, end: 5 }])
    core.focusAt(2)
    expect(getCursorPosition(host)).toBe(2)
  })

  test("currentCursor is null when the selection is outside the editor", () => {
    const other = document.createElement("div")
    other.textContent = "elsewhere"
    document.body.appendChild(other)
    setCursorPosition(other, 3)
    expect(core.currentCursor()).toBeNull()
  })

  test("renderWithCursor keeps the caret where it was", () => {
    core.render([{ type: "text", content: "hello", start: 0, end: 5 }])
    setCursorPosition(host, 3)
    core.renderWithCursor([{ type: "text", content: "help!", start: 0, end: 5 }])
    expect(getCursorPosition(host)).toBe(3)
  })

  test("caretState reports collapsed cursor inside the editor and zeros outside", () => {
    core.render([{ type: "text", content: "hello", start: 0, end: 5 }])
    setCursorPosition(host, 4)
    expect(core.caretState(5)).toEqual({ collapsed: true, cursorPosition: 4, textLength: 5 })
    window.getSelection()?.removeAllRanges()
    expect(core.caretState(5)).toEqual({ collapsed: false, cursorPosition: 0, textLength: 5 })
  })

  test("insertPart replaces the @-trigger with a pill and a following gap", () => {
    core.render([{ type: "text", content: "see @a", start: 0, end: 6 }])
    setCursorPosition(host, 6)
    const inserted = core.insertPart(filePill, {
      fallbackCursor: () => 6,
      text: () => "see @a",
    })
    expect(inserted).toBe(true)
    expect(core.parse()).toEqual([
      { type: "text", content: "see ", start: 0, end: 4 },
      { type: "file", path: "src/a.ts", content: "@a.ts", start: 4, end: 9 },
      { type: "text", content: " ", start: 9, end: 10 },
    ])
  })

  test("insertPart falls back to the prompt cursor when the selection is elsewhere", () => {
    core.render([{ type: "text", content: "hello", start: 0, end: 5 }])
    window.getSelection()?.removeAllRanges()
    const inserted = core.insertPart(
      { type: "text", content: "!", start: 0, end: 1 },
      { fallbackCursor: () => 5, text: () => "hello" },
    )
    expect(inserted).toBe(true)
    expect(core.parse()).toEqual([{ type: "text", content: "hello!", start: 0, end: 6 }])
  })

  test("insertPart refuses image parts", () => {
    expect(
      core.insertPart(
        { type: "image", filename: "x.png", mime: "image/png", url: "data:," } as never,
        { fallbackCursor: () => 0, text: () => "" },
      ),
    ).toBe(false)
  })

  test("collapseBackspaceAtZeroWidth snaps the caret to the start of a zero-width run", () => {
    const zw = document.createTextNode("\u200B")
    host.appendChild(document.createElement("br"))
    host.appendChild(zw)
    const selection = window.getSelection()!
    const range = document.createRange()
    range.setStart(zw, 1)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)

    core.collapseBackspaceAtZeroWidth()
    expect(window.getSelection()?.anchorOffset).toBe(0)
  })
})
