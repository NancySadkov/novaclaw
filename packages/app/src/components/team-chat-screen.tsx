import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { createQuery } from "@tanstack/solid-query"
import { Icon } from "@novaclaw/ui/v2/icon"
import type { AgentTeamChatMessage } from "@novaclaw/sdk/v2"
import { AgentPortrait } from "@/components/agent-portrait"
import { displayName, type AgentLike } from "@/apps/contacts"
import { agentColor } from "@/utils/agent"
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
  const accent = (id: string) => agentColor(id, agent(id)?.color)
  const timestamp = (message: AgentTeamChatMessage) =>
    new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium", timeStyle: "short" }).format(message.created)

  return (
    <div class="flex flex-col gap-2">
      <For each={props.messages}>
        {(message) => {
          const sender = () => agent(message.sender)
          return (
            <article
              data-team-chat-message={message.id}
              style={{ "--team-accent": accent(message.sender) }}
              class="relative overflow-hidden rounded-[14px] border border-[#cba7651f] bg-[linear-gradient(145deg,rgba(139,101,196,0.10),rgba(185,149,92,0.045))] px-3 py-2.5 shadow-[inset_0_1px_0_#ffffff0d] transition-colors hover:border-[#bd945b52]"
            >
              <span
                aria-hidden="true"
                class="absolute inset-y-2.5 left-0 w-[2px] rounded-r-full bg-[var(--team-accent)] opacity-50"
              />
              <div class="flex items-start gap-2.5">
                <AgentPortrait
                  id={message.sender}
                  name={name(message.sender)}
                  avatar={sender()?.avatar}
                  background={`color-mix(in srgb, ${accent(message.sender)} 30%, var(--v2-background-bg-layer-02))`}
                  class="size-8 ring-1 ring-[#cba76533]"
                />
                <div class="min-w-0 flex-1">
                  <div class="flex min-w-0 items-baseline gap-x-1.5">
                    <span class="truncate text-[12.5px] font-semibold text-amber-100">{name(message.sender)}</span>
                    <span class="shrink-0 truncate text-[11px] text-v2-text-text-muted">
                      → {name(message.recipient)}
                    </span>
                    <time class="ml-auto shrink-0 pl-2 text-[10px] tabular-nums text-v2-text-text-faint">
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

export function TeamChatScreen(props: { agentID: string; roster: readonly AgentLike[]; onBack: () => void }) {
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
  const officer = createMemo(() => roster().get(props.agentID))
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
    <div
      data-component="team-chat-screen"
      class="flex h-full w-full min-w-0 max-w-full flex-col overflow-hidden bg-v2-background-bg-base text-v2-text-text-base"
    >
      <header class="flex min-w-0 items-center gap-2.5 border-b border-v2-border-border-base px-3 py-2 sm:px-4">
        <button
          type="button"
          data-action="team-chat-back"
          class="-ml-1 flex size-7 shrink-0 items-center justify-center rounded-md text-v2-text-text-muted hover:bg-v2-background-bg-layer-02"
          aria-label={language.t("agentConfig.back")}
          title={language.t("agentConfig.back")}
          onClick={props.onBack}
        >
          <Icon name="chevron-left" size="normal" />
        </button>
        <AgentPortrait
          id={props.agentID}
          name={name(props.agentID)}
          avatar={officer()?.avatar}
          class="size-9 border border-v2-border-border-strong text-base"
        />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-semibold">{name(props.agentID)}</span>
          <span class="block truncate text-[11px] text-v2-text-text-muted">
            {officer()?.title ?? language.t("agentConfig.noTitle")}
          </span>
        </span>
        <span class="hidden shrink-0 items-center gap-1.5 rounded-full border border-amber-300/20 bg-amber-200/5 px-2.5 py-1 text-[11px] font-medium text-amber-100 sm:flex">
          <Icon name="chats" class="size-3.5" />
          {language.t("teamChat.title")}
        </span>
      </header>

      <div
        ref={scroller}
        onScroll={(event) => {
          const target = event.currentTarget
          pinned = isTeamChatPinned(target.scrollTop, target.clientHeight, target.scrollHeight)
        }}
        class="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-[radial-gradient(ellipse_at_80%_-10%,rgba(116,72,161,0.10),transparent_55%)]"
      >
        <div class="mx-auto flex w-full max-w-3xl flex-col gap-2.5 px-3 py-3 sm:px-4 sm:py-4">
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
            <div class="sticky top-0 z-10 flex items-center justify-between gap-3 rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-3 py-2 text-[11px] text-v2-text-text-muted shadow-sm">
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
            <div class="flex justify-center">
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
    </div>
  )
}
