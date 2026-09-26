import { createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { Todo } from "@novaclaw/sdk/v2"
import { useResolvedSessionID } from "@/pages/session/session-layout"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import { todoDockAtBoundary, todoState } from "./session-composer-todo"

export function createSessionComposerController(options?: { closeMs?: number | (() => number) }) {
  // 🔴 The RESOLVED session id, not `useParams().id`. A route addresses a colleague as often as a
  // chat, and under a colleague there is no `id` param — so every read below was `undefined`: the
  // dock never opened and `live()` was permanently false on a working agent. Same class as the Stop
  // click that did nothing (2026-09-26), same subtree, same fix.
  const sessionID = useResolvedSessionID()
  const sync = useSync()
  const serverSync = useServerSync()

  const todos = createMemo((): Todo[] => {
    const id = sessionID()
    if (!id) return []
    return serverSync().session.data.todo[id] ?? []
  })

  const done = createMemo(
    () => todos().length > 0 && todos().every((todo) => todo.status === "completed" || todo.status === "cancelled"),
  )

  const live = createMemo(() => sync().data.session_working(sessionID() ?? ""))

  const [store, setStore] = createStore({
    sessionID: sessionID(),
    dock: todos().length > 0 && !done() && live(),
    closing: false,
    opening: false,
  })

  let timer: number | undefined
  let raf: number | undefined

  const closeMs = () => {
    const value = options?.closeMs
    if (typeof value === "function") return Math.max(0, value())
    if (typeof value === "number") return Math.max(0, value)
    return 400
  }

  const scheduleClose = () => {
    if (timer) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      setStore({ dock: false, closing: false })
      timer = undefined
    }, closeMs())
  }

  // Keep stale turn todos from reopening if the model never clears them.
  const clear = () => {
    const id = sessionID()
    if (!id) return
    sync().set("todo", id, [])
  }

  createEffect(
    on(
      () => [sessionID(), todos().length, done(), live()] as const,
      ([id, count, complete, active], previous) => {
        if (raf) cancelAnimationFrame(raf)
        raf = undefined

        const next = todoState({
          count,
          done: complete,
          live: active,
        })

        if (!previous || previous[0] !== id) {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          setStore({ sessionID: id, dock: todoDockAtBoundary(next), closing: false, opening: false })
          if (next === "clear") clear()
          return
        }

        if (next === "hide") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          setStore({ dock: false, closing: false, opening: false })
          return
        }

        if (next === "clear") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          clear()
          return
        }

        if (next === "open") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          const hidden = !store.dock || store.closing
          setStore({ dock: true, closing: false })
          if (hidden) {
            setStore("opening", true)
            raf = requestAnimationFrame(() => {
              setStore("opening", false)
              raf = undefined
            })
            return
          }
          setStore("opening", false)
          return
        }

        setStore({ dock: true, opening: false, closing: true })
        if (!timer) scheduleClose()
      },
    ),
  )

  onCleanup(() => {
    if (!timer) return
    window.clearTimeout(timer)
  })

  onCleanup(() => {
    if (!raf) return
    cancelAnimationFrame(raf)
  })

  return {
    todos,
    dock: () =>
      store.sessionID === sessionID()
        ? store.dock
        : todoDockAtBoundary(todoState({ count: todos().length, done: done(), live: live() })),
    closing: () => store.sessionID === sessionID() && store.closing,
    opening: () => store.sessionID === sessionID() && store.opening,
  }
}

export type SessionComposerController = ReturnType<typeof createSessionComposerController>
