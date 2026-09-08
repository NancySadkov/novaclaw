import type { Store, SetStoreFunction } from "solid-js/store"
import { selectionFromLines } from "@/context/file/types"
import type { useComments } from "@/context/comments"
import type { usePrompt } from "@/context/prompt"
import type { createEditorCore } from "./editor-core"
import {
  navigatePromptHistory,
  promptLength,
  type PromptHistoryComment,
  type PromptHistoryEntry,
  type PromptInputHistory,
} from "./history"
import type { PromptInputTransientState } from "./transient-state"

type Input = {
  history: PromptInputHistory
  comments: Pick<ReturnType<typeof useComments>, "all" | "replace">
  prompt: Pick<ReturnType<typeof usePrompt>, "current" | "set"> & {
    context: Pick<ReturnType<typeof usePrompt>["context"], "items" | "replaceComments">
  }
  editor: Pick<ReturnType<typeof createEditorCore>, "focusAt">
  store: Store<PromptInputTransientState>
  setStore: SetStoreFunction<PromptInputTransientState>
  queueScroll: () => void
}

/**
 * Owns the composer's history cursor and the lossless comment/context round-trip.
 *
 * History is more than prompt text: review comments live in both the comments store and prompt
 * context. Restoring only one side makes the transcript look right while submission silently loses
 * evidence, so the controller keeps the two writes inseparable.
 */
export function createPromptInputHistoryController(input: Input) {
  const comments = () => {
    const byID = new Map(input.comments.all().map((item) => [`${item.file}\n${item.id}`, item] as const))
    return input.prompt.context.items().flatMap((item) => {
      if (item.type !== "file") return []
      const comment = item.comment?.trim()
      if (!comment) return []

      const selection = item.commentID ? byID.get(`${item.path}\n${item.commentID}`)?.selection : undefined
      const nextSelection =
        selection ??
        (item.selection
          ? {
              start: item.selection.startLine,
              end: item.selection.endLine,
            }
          : undefined)
      if (!nextSelection) return []

      return [
        {
          id: item.commentID ?? item.key,
          path: item.path,
          selection: { ...nextSelection },
          comment,
          time: item.commentID ? (byID.get(`${item.path}\n${item.commentID}`)?.time ?? Date.now()) : Date.now(),
          origin: item.commentOrigin,
          preview: item.preview,
        } satisfies PromptHistoryComment,
      ]
    })
  }

  const applyComments = (items: PromptHistoryComment[]) => {
    input.comments.replace(
      items.map((item) => ({
        id: item.id,
        file: item.path,
        selection: { ...item.selection },
        comment: item.comment,
        time: item.time,
      })),
    )
    input.prompt.context.replaceComments(
      items.map((item) => ({
        type: "file" as const,
        path: item.path,
        selection: selectionFromLines(item.selection),
        comment: item.comment,
        commentID: item.id,
        commentOrigin: item.origin,
        preview: item.preview,
      })),
    )
  }

  const apply = (entry: PromptHistoryEntry, position: "start" | "end") => {
    const length = position === "start" ? 0 : promptLength(entry.prompt)
    input.setStore("applyingHistory", true)
    applyComments(entry.comments)
    input.prompt.set(entry.prompt, length)
    requestAnimationFrame(() => {
      input.editor.focusAt(length)
      input.setStore("applyingHistory", false)
      input.queueScroll()
    })
  }

  const reset = (force = false) => {
    if (!force && (input.store.historyIndex < 0 || input.store.applyingHistory)) return
    input.setStore("historyIndex", -1)
    input.setStore("savedPrompt", null)
  }

  const add = (prompt: Parameters<PromptInputHistory["add"]>[0], mode: "normal" | "shell") => {
    input.history.add(prompt, mode, mode === "shell" ? [] : comments())
  }

  const navigate = (direction: "up" | "down") => {
    const result = navigatePromptHistory({
      direction,
      entries: input.history.entries(input.store.mode),
      historyIndex: input.store.historyIndex,
      currentPrompt: input.prompt.current(),
      currentComments: comments(),
      savedPrompt: input.store.savedPrompt,
    })
    if (!result.handled) return false
    input.setStore("historyIndex", result.historyIndex)
    input.setStore("savedPrompt", result.savedPrompt)
    apply(result.entry, result.cursor)
    return true
  }

  return {
    comments,
    reset,
    add,
    navigate,
  }
}
