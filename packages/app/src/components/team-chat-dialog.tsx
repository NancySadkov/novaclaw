import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { createQuery } from "@tanstack/solid-query"
import { Dialog, DialogHeader, DialogTitle } from "@novaclaw/ui/v2/dialog-v2"
import { Icon } from "@novaclaw/ui/v2/icon"
import type { AgentTeamChatMessage } from "@novaclaw/sdk/v2"
import { AgentPortrait } from "@/components/agent-portrait"
import { displayName, type AgentLike } from "@/apps/contacts"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"

export const mergeTeamChatMessages = (
  current: readonly AgentTeamChatMessage[],
  incoming: readonly AgentTeamChatMessage[],
): readonly AgentTeamChatMessage[] => {
  const messages = new Map(current.map((message) => [message.id, message]))
  for (const message of incoming) messages.set(message.id, message)
  return [...messages.values()].sort((left, right) => left.created - right.created || left.id.localeCompare(right.id))
}

export const isTeamChatPinned = (scrollTop: number, clientHeight: number, scrollHeight: number) =>
  scrollHeight - scrollTop - clientHeight <= 24

export const anchoredScrollTop = (scrollTop: number, previousHeight: number, nextHeight: number) =>
  scrollTop + Math.max(0, nextHeight - previousHeight)

export interface TeamChatScrollAnchor {
  readonly id: string
  readonly top: number
}

export const captureTeamChatScrollAnchor = (scroller: HTMLElement): TeamChatScrollAnchor | undefined => {
  const viewportTop = scroller.getBoundingClientRect().top
  const message = [...scroller.querySelectorAll<HTMLElement>("[data-team-chat-message]")].find(
    (element) => element.getBoundingClientRect().bottom >= viewportTop,
  )
  const id = message?.dataset.teamChatMessage
  return message && id ? { id, top: message.getBoundingClientRect().top } : undefined
}

export const restoreTeamChatScrollAnchor = (scroller: HTMLElement, anchor: TeamChatScrollAnchor): boolean => {
  const message = [...scroller.querySelectorAll<HTMLElement>("[data-team-chat-message]")].find(
    (element) => element.dataset.teamChatMessage === anchor.id,
  )
  if (!message) return false
  scroller.scrollTop += message.getBoundingClientRect().top - anchor.top
  return true
}

export function TeamChatMessageList(props: {
  messages: readonly AgentTeamChatMessage[]
  roster: readonly AgentLike[]
}) {
  const language = useLanguage()
  const roster = createMemo(() => new Map(props.roster.map((agent) => [agent.id, agent])))
  const agent = (id: string) => roster().get(id)
  const name = (id: string) => agent(id)?.name?.trim() || displayName(id)
  const timestamp = (message: AgentTeamChatMessage) =>
    new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium", timeStyle: "short" }).format(message.created)

  return (
    <div class="flex flex-col gap-2.5">
      <For each={props.messages}>
        {(message) => {
          const sender = () => agent(message.sender)
          return (
            <article
              data-team-chat-message={message.id}
              class="rounded-xl border border-v2-border-border-muted bg-[linear-gradient(145deg,rgba(185,149,92,0.06),rgba(102,69,138,0.08))] px-3 py-2.5 shadow-[inset_0_1px_rgba(255,255,255,0.025)]"
            >
              <div class="flex items-start gap-2.5">
                <AgentPortrait
                  id={message.sender}
                  name={name(message.sender)}
                  avatar={sender()?.avatar}
                  background={sender()?.color}
                  class="size-8 ring-1 ring-amber-300/25"
                />
                <div class="min-w-0 flex-1">
                  <div class="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                    <span class="truncate text-[12px] font-semibold text-amber-100">{name(message.sender)}</span>
                    <span class="truncate text-[10px] text-v2-text-text-faint">→ {name(message.recipient)}</span>
                    <time class="ml-auto shrink-0 text-[10px] tabular-nums text-v2-text-text-faint">
                      {timestamp(message)}
                    </time>
                  </div>
                  <p class="mt-1 whitespace-pre-wrap break-words text-[13px] leading-5 text-v2-text-text-base">
                    {message.text}
                  </p>
                </div>
              </div>
            </article>
          )
        }}
      </For>
    </div>
  )
}

export function TeamChatDialog(props: { agentID: string; roster: readonly AgentLike[] }) {
  const sdk = useSDK()
  const language = useLanguage()
  const server = useServer()
  let scroller: HTMLDivElement | undefined
  let pinned = true
  const [messages, setMessages] = createSignal<readonly AgentTeamChatMessage[]>([])
  const [olderCursor, setOlderCursor] = createSignal<string>()
  const [latestCursor, setLatestCursor] = createSignal<string>()
  const [loadingOlder, setLoadingOlder] = createSignal(false)
  const [olderFailed, setOlderFailed] = createSignal(false)

  const initialQuery = createQuery(() => ({
    queryKey: ["agent-team-chat", server.key, sdk().directory, props.agentID],
    queryFn: async () => {
      const response = await sdk().client.v2.agent.teamChat({ agentID: props.agentID, limit: "50" })
      if (response.error) throw response.error
      return response.data?.data
    },
    refetchInterval: () => (latestCursor() ? false : 2_000),
  }))
  const tailQuery = createQuery(() => ({
    queryKey: ["agent-team-chat-tail", server.key, sdk().directory, props.agentID, latestCursor()],
    enabled: Boolean(latestCursor()),
    queryFn: async () => {
      const response = await sdk().client.v2.agent.teamChat({
        agentID: props.agentID,
        limit: "50",
        after: latestCursor(),
      })
      if (response.error) throw response.error
      return response.data?.data
    },
    refetchInterval: 2_000,
  }))
  const roster = createMemo(() => new Map(props.roster.map((agent) => [agent.id, agent])))
  const name = (id: string) => roster().get(id)?.name?.trim() || displayName(id)

  createEffect(() => {
    const page = initialQuery.data
    if (!page) return
    const shouldFollow = pinned
    setMessages((current) => mergeTeamChatMessages(current, page.data))
    setOlderCursor(page.cursor.older)
    if (page.cursor.latest) setLatestCursor(page.cursor.latest)
    if (shouldFollow) queueMicrotask(() => scroller?.scrollTo({ top: scroller.scrollHeight }))
  })

  createEffect(() => {
    const page = tailQuery.data
    if (!page) return
    if (page.cursor.latest) setLatestCursor(page.cursor.latest)
    if (page.data.length === 0) return
    const shouldFollow = pinned
    setMessages((current) => mergeTeamChatMessages(current, page.data))
    if (shouldFollow) queueMicrotask(() => scroller?.scrollTo({ top: scroller.scrollHeight }))
  })

  const loadOlder = async () => {
    const before = olderCursor()
    if (!before || loadingOlder()) return
    setLoadingOlder(true)
    setOlderFailed(false)
    const anchor = scroller ? captureTeamChatScrollAnchor(scroller) : undefined
    const previousTop = scroller?.scrollTop ?? 0
    const previousHeight = scroller?.scrollHeight ?? 0
    try {
      const response = await sdk().client.v2.agent.teamChat({ agentID: props.agentID, limit: "50", before })
      if (response.error) throw response.error
      const page = response.data?.data
      if (!page) return
      setMessages((current) => mergeTeamChatMessages(current, page.data))
      setOlderCursor(page.cursor.older)
      queueMicrotask(() => {
        if (!scroller) return
        if (anchor && restoreTeamChatScrollAnchor(scroller, anchor)) return
        scroller.scrollTop = anchoredScrollTop(previousTop, previousHeight, scroller.scrollHeight)
      })
    } catch {
      setOlderFailed(true)
    } finally {
      setLoadingOlder(false)
    }
  }

  return (
    <Dialog size="normal" fit>
      <div class="flex h-[min(82dvh,42rem)] max-h-[calc(100dvh-1rem)] min-h-0 w-full flex-col overflow-hidden bg-v2-background-bg-base text-v2-text-text-base sm:w-[34rem]">
        <header class="relative overflow-hidden border-b border-amber-300/20 bg-[radial-gradient(ellipse_at_top_left,rgba(214,172,78,0.16),transparent_58%),linear-gradient(135deg,rgba(65,37,85,0.94),rgba(18,9,30,0.98))] px-4 py-3 shadow-[inset_0_1px_rgba(255,240,205,0.12)]">
          <DialogHeader>
            <div class="relative flex items-center gap-3">
              <span class="flex size-9 shrink-0 items-center justify-center rounded-xl border border-amber-300/25 bg-amber-200/10 text-amber-200 shadow-[0_0_22px_rgba(210,165,76,0.12)]">
                <Icon name="chats" class="size-5" />
              </span>
              <div class="min-w-0">
                <DialogTitle>{language.t("teamChat.title")}</DialogTitle>
                <p class="mt-0.5 truncate text-[11px] text-v2-text-text-muted">
                  {language.t("teamChat.subtitle", { officer: name(props.agentID) })}
                </p>
              </div>
            </div>
          </DialogHeader>
        </header>

        <div
          ref={scroller}
          onScroll={(event) => {
            const target = event.currentTarget
            pinned = isTeamChatPinned(target.scrollTop, target.clientHeight, target.scrollHeight)
          }}
          class="min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(ellipse_at_85%_0%,rgba(116,72,161,0.10),transparent_52%)] px-3 py-3 sm:px-4"
        >
          <Show when={initialQuery.isPending}>
            <div class="flex h-40 items-center justify-center text-xs text-v2-text-text-faint">
              {language.t("teamChat.loading")}
            </div>
          </Show>
          <Show when={initialQuery.isError && messages().length === 0}>
            <div class="mx-auto mt-8 max-w-sm rounded-xl border border-v2-state-border-danger bg-v2-state-bg-danger px-4 py-3 text-center text-xs text-v2-state-fg-danger">
              <p>{language.t("teamChat.unavailable")}</p>
              <button
                type="button"
                class="mt-2 font-semibold underline underline-offset-2"
                onClick={() => void initialQuery.refetch()}
              >
                {language.t("teamChat.retry")}
              </button>
            </div>
          </Show>
          <Show when={!initialQuery.isPending && !initialQuery.isError && messages().length === 0}>
            <div class="flex h-40 flex-col items-center justify-center text-center">
              <Icon name="chats" class="mb-2 size-6 text-v2-icon-icon-accent" />
              <p class="text-sm text-v2-text-text-muted">{language.t("teamChat.empty")}</p>
              <p class="mt-1 max-w-xs text-[11px] leading-4 text-v2-text-text-faint">
                {language.t("teamChat.emptyHint")}
              </p>
            </div>
          </Show>
          <Show when={tailQuery.isError && messages().length > 0}>
            <div class="sticky top-0 z-10 mb-3 flex items-center justify-between gap-3 rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-3 py-2 text-[11px] text-v2-text-text-muted shadow-sm">
              <span>{language.t("teamChat.reconnecting")}</span>
              <button
                type="button"
                class="shrink-0 font-semibold text-amber-100 underline underline-offset-2"
                onClick={() => void tailQuery.refetch()}
              >
                {language.t("teamChat.retry")}
              </button>
            </div>
          </Show>
          <Show when={olderCursor()}>
            <div class="mb-3 flex justify-center">
              <button
                type="button"
                class="rounded-full border border-amber-300/20 bg-amber-200/5 px-3 py-1.5 text-[11px] font-medium text-amber-100 transition-colors hover:bg-amber-200/10 disabled:opacity-50"
                disabled={loadingOlder()}
                onClick={() => void loadOlder()}
              >
                {loadingOlder()
                  ? language.t("teamChat.loading")
                  : olderFailed()
                    ? language.t("teamChat.retry")
                    : language.t("teamChat.loadOlder")}
              </button>
            </div>
          </Show>
          <TeamChatMessageList messages={messages()} roster={props.roster} />
        </div>
      </div>
    </Dialog>
  )
}
