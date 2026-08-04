// ui-arch-hardening P4a — editor-core: the composer's contenteditable/selection/cursor DOM
// surgery, extracted from prompt-input.tsx behind one small tested interface. Together with
// editor-dom.ts (the node-walk primitives) this is the ONLY place allowed to touch
// Range/Selection for the composer; the component keeps state policy (what to render, when to
// focus) and calls in. Everything here is a verbatim lift — behavior changes are not P4's job.
import type { AgentPart, ContentPart, FileAttachmentPart, Prompt } from "@/context/prompt"
import { createTextFragment, getCursorPosition, setCursorPosition, setRangeEdge } from "./editor-dom"

export type EditorCaretState = { collapsed: boolean; cursorPosition: number; textLength: number }

export type EditorInsertContext = {
  /** The prompt-state cursor to restore when the DOM selection is elsewhere. */
  fallbackCursor: () => number
  /** The full prompt text (for locating an @-trigger before the cursor). */
  text: () => string
}

export function createEditorCore(input: { editor: () => HTMLElement; empty: () => Prompt }) {
  const el = input.editor

  const clear = () => {
    el().innerHTML = ""
  }

  const setText = (text: string) => {
    clear()
    el().textContent = text
  }

  const createPill = (part: FileAttachmentPart | AgentPart) => {
    const pill = document.createElement("span")
    pill.textContent = part.content
    pill.setAttribute("data-type", part.type)
    if (part.type === "file") pill.setAttribute("data-path", part.path)
    if (part.type === "agent") pill.setAttribute("data-name", part.name)
    pill.setAttribute("contenteditable", "false")
    pill.style.userSelect = "text"
    pill.style.cursor = "default"
    return pill
  }

  const isNormalized = () =>
    Array.from(el().childNodes).every((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? ""
        if (!text.includes("\u200B")) return true
        if (text !== "\u200B") return false

        const prev = node.previousSibling
        const next = node.nextSibling
        const prevIsBr = prev?.nodeType === Node.ELEMENT_NODE && (prev as HTMLElement).tagName === "BR"
        return !!prevIsBr && !next
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return false
      const element = node as HTMLElement
      if (element.dataset.type === "file") return true
      if (element.dataset.type === "agent") return true
      return element.tagName === "BR"
    })

  const render = (parts: Prompt) => {
    clear()
    for (const part of parts) {
      if (part.type === "text") {
        el().appendChild(createTextFragment(part.content))
        continue
      }
      if (part.type === "file" || part.type === "agent") {
        el().appendChild(createPill(part))
      }
    }

    const last = el().lastChild
    if (last?.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR") {
      el().appendChild(document.createTextNode("\u200B"))
    }
  }

  const currentCursor = () => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || !el().contains(selection.anchorNode)) return null
    return getCursorPosition(el())
  }

  const renderWithCursor = (parts: Prompt) => {
    const cursor = currentCursor()
    render(parts)
    if (cursor !== null) setCursorPosition(el(), cursor)
  }

  const parse = (): Prompt => {
    const parts: Prompt = []
    let position = 0
    let buffer = ""

    const flushText = () => {
      let content = buffer
      if (content.includes("\r")) content = content.replace(/\r\n?/g, "\n")
      if (content.includes("\u200B")) content = content.replace(/\u200B/g, "")
      buffer = ""
      if (!content) return
      parts.push({ type: "text", content, start: position, end: position + content.length })
      position += content.length
    }

    const pushFile = (file: HTMLElement) => {
      const content = file.textContent ?? ""
      parts.push({
        type: "file",
        path: file.dataset.path!,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const pushAgent = (agent: HTMLElement) => {
      const content = agent.textContent ?? ""
      parts.push({
        type: "agent",
        name: agent.dataset.name!,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const visit = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        buffer += node.textContent ?? ""
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return

      const element = node as HTMLElement
      if (element.dataset.type === "file") {
        flushText()
        pushFile(element)
        return
      }
      if (element.dataset.type === "agent") {
        flushText()
        pushAgent(element)
        return
      }
      if (element.tagName === "BR") {
        buffer += "\n"
        return
      }

      for (const child of Array.from(element.childNodes)) {
        visit(child)
      }
    }

    const children = Array.from(el().childNodes)
    children.forEach((child, index) => {
      const isBlock = child.nodeType === Node.ELEMENT_NODE && ["DIV", "P"].includes((child as HTMLElement).tagName)
      visit(child)
      if (isBlock && index < children.length - 1) {
        buffer += "\n"
      }
    })

    flushText()

    if (parts.length === 0) parts.push(...input.empty())
    return parts
  }

  const placeCursorAtEnd = () => {
    el().focus()
    const range = document.createRange()
    const selection = window.getSelection()
    range.selectNodeContents(el())
    range.collapse(false)
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  const focusAt = (cursor: number) => {
    el().focus()
    setCursorPosition(el(), cursor)
  }

  const caretState = (textLength: number): EditorCaretState => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    const anchorNode = selection.anchorNode
    if (!anchorNode || !el().contains(anchorNode)) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    return {
      collapsed: selection.isCollapsed,
      cursorPosition: getCursorPosition(el()),
      textLength,
    }
  }

  /** The DOM half of adding a part at the cursor. Returns false when no usable selection exists. */
  const insertPart = (part: ContentPart, ctx: EditorInsertContext): boolean => {
    if (part.type === "image") return false

    const selection = window.getSelection()
    if (!selection) return false

    if (selection.rangeCount === 0 || !el().contains(selection.anchorNode)) {
      el().focus()
      setCursorPosition(el(), ctx.fallbackCursor())
    }

    if (selection.rangeCount === 0) return false
    const range = selection.getRangeAt(0)
    if (!el().contains(range.startContainer)) return false

    if (part.type === "file" || part.type === "agent") {
      const cursorPosition = getCursorPosition(el())
      const textBeforeCursor = ctx.text().substring(0, cursorPosition)
      const atMatch = textBeforeCursor.match(/@(\S*)$/)
      const pill = createPill(part)
      const gap = document.createTextNode(" ")

      if (atMatch) {
        const start = atMatch.index ?? cursorPosition - atMatch[0].length
        setRangeEdge(el(), range, "start", start)
        setRangeEdge(el(), range, "end", cursorPosition)
      }

      range.deleteContents()
      range.insertNode(gap)
      range.insertNode(pill)
      range.setStartAfter(gap)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    if (part.type === "text") {
      const fragment = createTextFragment(part.content)
      const last = fragment.lastChild
      range.deleteContents()
      range.insertNode(fragment)
      if (last) {
        if (last.nodeType === Node.TEXT_NODE) {
          const text = last.textContent ?? ""
          if (text === "\u200B") {
            range.setStart(last, 0)
          }
          if (text !== "\u200B") {
            range.setStart(last, text.length)
          }
        }
        if (last.nodeType !== Node.TEXT_NODE) {
          const isBreak = last.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR"
          const next = last.nextSibling
          const emptyText = next?.nodeType === Node.TEXT_NODE && (next.textContent ?? "") === ""
          if (isBreak && (!next || emptyText)) {
            const placeholder = next && emptyText ? next : document.createTextNode("\u200B")
            if (!next) last.parentNode?.insertBefore(placeholder, null)
            placeholder.textContent = "\u200B"
            range.setStart(placeholder, 0)
          } else {
            range.setStartAfter(last)
          }
        }
      }
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    return true
  }

  /**
   * Before Backspace deletes into a zero-width placeholder run, snap the caret to its start so
   * the delete removes real content instead of the invisible scaffolding.
   */
  const collapseBackspaceAtZeroWidth = () => {
    const selection = window.getSelection()
    if (!selection || !selection.isCollapsed) return
    const node = selection.anchorNode
    const offset = selection.anchorOffset
    if (!node || node.nodeType !== Node.TEXT_NODE) return
    const text = node.textContent ?? ""
    if (/^\u200B+$/.test(text) && offset > 0) {
      const range = document.createRange()
      range.setStart(node, 0)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }
  }

  const scrollCursorIntoView = (container: HTMLElement | undefined, opts: { inset: number; contentLength: number }) => {
    const selection = window.getSelection()
    if (!container || !selection || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)
    if (!el().contains(range.startContainer)) return

    const cursor = getCursorPosition(el())
    if (cursor >= opts.contentLength) {
      container.scrollTop = container.scrollHeight
      return
    }

    const rect = range.getClientRects().item(0) ?? range.getBoundingClientRect()
    if (!rect.height) return

    const containerRect = container.getBoundingClientRect()
    const top = rect.top - containerRect.top + container.scrollTop
    const bottom = rect.bottom - containerRect.top + container.scrollTop
    const padding = 12

    if (top < container.scrollTop + padding) {
      container.scrollTop = Math.max(0, top - padding)
      return
    }

    if (bottom > container.scrollTop + container.clientHeight - opts.inset) {
      container.scrollTop = bottom - container.clientHeight + opts.inset
    }
  }

  return {
    clear,
    setText,
    createPill,
    isNormalized,
    render,
    renderWithCursor,
    currentCursor,
    parse,
    placeCursorAtEnd,
    focusAt,
    caretState,
    insertPart,
    collapseBackspaceAtZeroWidth,
    scrollCursorIntoView,
  }
}

export type EditorCore = ReturnType<typeof createEditorCore>
