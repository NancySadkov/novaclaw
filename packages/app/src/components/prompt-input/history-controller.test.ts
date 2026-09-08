import { expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import type { Prompt } from "@/context/prompt"
import { createPromptInputHistory } from "./history"
import { createPromptInputHistoryController } from "./history-controller"
import type { PromptInputTransientState } from "./transient-state"

test("history restoration updates prompt context and visible comments as one operation", async () => {
  const saved: Prompt = [{ type: "text", content: "saved", start: 0, end: 5 }]
  const history = createPromptInputHistory()
  history.add(saved, "normal", [
    {
      id: "comment-1",
      path: "src/example.ts",
      selection: { start: 3, end: 4 },
      comment: "Keep this evidence",
      time: 42,
      origin: "review",
      preview: "example",
    },
  ])

  const [store, setStore] = createStore<PromptInputTransientState>({
    popover: null,
    historyIndex: -1,
    savedPrompt: null,
    placeholder: 0,
    draggingType: null,
    mode: "normal",
    applyingHistory: false,
    variantOpen: false,
  })
  let current: Prompt = [{ type: "text", content: "draft", start: 0, end: 5 }]
  let cursor = -1
  let lineComments: Array<{
    id: string
    file: string
    selection: { start: number; end: number }
    comment: string
    time: number
  }> = []
  let contextItems: Array<Record<string, unknown>> = []

  const controller = createPromptInputHistoryController({
    history,
    comments: {
      all: () => lineComments,
      replace: (items) => {
        lineComments = items
      },
    },
    prompt: {
      current: () => current,
      set: (next) => {
        current = next
      },
      context: {
        items: () => contextItems as never,
        replaceComments: (items) => {
          contextItems = items
        },
      },
    },
    editor: {
      focusAt: (next) => {
        cursor = next
      },
    },
    store,
    setStore,
    queueScroll: () => {},
  })

  expect(controller.navigate("up")).toBe(true)
  expect(current).toEqual(saved)
  expect(lineComments).toEqual([
    {
      id: "comment-1",
      file: "src/example.ts",
      selection: { start: 3, end: 4 },
      comment: "Keep this evidence",
      time: 42,
    },
  ])
  expect(contextItems).toEqual([
    {
      type: "file",
      path: "src/example.ts",
      selection: { startLine: 3, startChar: 0, endLine: 4, endChar: 0 },
      comment: "Keep this evidence",
      commentID: "comment-1",
      commentOrigin: "review",
      preview: "example",
    },
  ])

  await new Promise((resolve) => requestAnimationFrame(resolve))
  expect(store.applyingHistory).toBe(false)
  expect(cursor).toBe(0)
})
