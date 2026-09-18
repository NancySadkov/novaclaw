import { createComputed, on, type Accessor } from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
import type { PromptHistoryEntry } from "./history"

export type PromptInputTransientState = {
  historyIndex: number
  savedPrompt: PromptHistoryEntry | null
  draggingType: "image" | null
  mode: "normal" | "shell"
  applyingHistory: boolean
  variantOpen: boolean
}

function resetPromptInputTransientState(setStore: SetStoreFunction<PromptInputTransientState>) {
  setStore({
    historyIndex: -1,
    savedPrompt: null,
    draggingType: null,
    mode: "normal",
    applyingHistory: false,
    variantOpen: false,
  })
}

export function createPromptInputTransientState(identity: Accessor<unknown>) {
  const [store, setStore] = createStore<PromptInputTransientState>({
    historyIndex: -1,
    savedPrompt: null,
    draggingType: null,
    mode: "normal",
    applyingHistory: false,
    variantOpen: false,
  })

  createComputed(on(identity, () => resetPromptInputTransientState(setStore), { defer: true }))

  return [store, setStore] as const
}
