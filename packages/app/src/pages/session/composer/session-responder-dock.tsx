import { Show, createMemo, createResource, createSignal } from "solid-js"
import { Button } from "@novaclaw/ui/button"
import { DockTray } from "@novaclaw/ui/dock-surface"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { switchResponder } from "@/utils/fs-api"

// B10 — the live control handoff dock: who is speaking on OUR side, with take-over /
// hand-back controls. Shown only under the new layout (V2 sessions). When the operator
// takes control, Nova stops auto-responding (the runner gate); handing back drains any
// input that queued while the human held the conversation.
export function SessionResponderDock(props: { sessionID: string | undefined }) {
  const language = useLanguage()
  const server = useServer()
  const serverSync = useServerSync()
  const [busy, setBusy] = createSignal(false)

  const session = createMemo(() => {
    const id = props.sessionID
    return id ? serverSync().session.get(id) : undefined
  })
  const responder = createMemo(() => (session() as { responder?: "nova" | "operator" } | undefined)?.responder ?? "nova")
  const [directory] = createResource(session, (s) => (s as { directory?: string } | undefined)?.directory)

  const toggle = async () => {
    const id = props.sessionID
    const dir = directory()
    if (!id || !dir || busy() || !server.current) return
    const next = responder() === "operator" ? "nova" : "operator"
    setBusy(true)
    try {
      await switchResponder(server.current!.http, { directory: dir, sessionID: id, responder: next })
      // The SSE row update refreshes serverSync; nudge an immediate optimistic read.
      void serverSync().session.get(id)
    } catch (error) {
      console.error("switchResponder failed", error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show when={props.sessionID && responder() === "operator"}>
      <DockTray data-component="session-responder-dock">
        <div class="pl-3 pr-2 py-2 flex items-center gap-2">
          <span class="shrink-0 text-14-regular text-text-strong cursor-default">
            {language.t("session.responderDock.operator")}
          </span>
          <span class="min-w-0 flex-1 truncate text-13-regular text-text-base cursor-default">
            {language.t("session.responderDock.operatorHint")}
          </span>
          <Button size="small" variant="secondary" class="shrink-0 ml-auto" disabled={busy()} onClick={() => void toggle()}>
            {language.t("session.responderDock.handBack")}
          </Button>
        </div>
      </DockTray>
    </Show>
  )
}

// A compact "take control" affordance for the composer toolbar (visible while Nova responds).
export function ResponderTakeoverButton(props: { sessionID: string | undefined }) {
  const language = useLanguage()
  const server = useServer()
  const serverSync = useServerSync()
  const [busy, setBusy] = createSignal(false)
  const session = createMemo(() => (props.sessionID ? serverSync().session.get(props.sessionID) : undefined))
  const responder = createMemo(() => (session() as { responder?: "nova" | "operator" } | undefined)?.responder ?? "nova")

  const takeOver = async () => {
    const id = props.sessionID
    const dir = (session() as { directory?: string } | undefined)?.directory
    if (!id || !dir || busy() || !server.current) return
    setBusy(true)
    try {
      await switchResponder(server.current!.http, { directory: dir, sessionID: id, responder: "operator" })
    } catch (error) {
      console.error("switchResponder failed", error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show when={props.sessionID && responder() === "nova"}>
      <Button size="small" variant="ghost" disabled={busy()} onClick={() => void takeOver()}>
        {language.t("session.responderDock.takeOver")}
      </Button>
    </Show>
  )
}
