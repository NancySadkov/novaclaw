import { createMemo, createEffect, createSignal, on, onCleanup, For, Show } from "solid-js"
import type { JSX } from "solid-js"
import { useSync } from "@/context/sync"
import { useServerSync } from "@/context/server-sync"
import { findLast } from "@novaclaw/core/util/array"
import { Icon } from "@novaclaw/ui/v2/icon"
import { Markdown } from "@novaclaw/session-ui/markdown"
import { ScrollView } from "@novaclaw/ui/scroll-view"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import type { SessionMessage } from "@novaclaw/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { useModels } from "@/context/models"
import { useLocal } from "@/context/local"
import { useSDK } from "@/context/sdk"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { useSessionLayout } from "@/pages/session/session-layout"
import { AgentPortrait } from "@/components/agent-portrait"
import { displayName } from "@/apps/contacts"
import { agentColor } from "@/utils/agent"
import { getSessionContext, getSessionTokenTotal } from "./session-context-metrics"
import { estimateSessionContextBreakdown, type SessionContextBreakdownKey } from "./session-context-breakdown"
import {
  downloadPlainText,
  serializeContextSegment,
  serializeSessionTranscript,
  sessionExportFilename,
} from "./session-context-export"
import { createSessionContextFormatter } from "./session-context-format"
import { sessionCompactionEvents } from "./session-compaction-events"
import { showToast } from "@/utils/toast"

const BREAKDOWN_COLOR: Record<SessionContextBreakdownKey, string> = {
  system: "var(--syntax-info)",
  user: "var(--syntax-success)",
  assistant: "var(--syntax-property)",
  tool: "var(--syntax-warning)",
  other: "var(--syntax-comment)",
}

function Detail(props: { label: string; value: JSX.Element }) {
  return (
    <div class="min-w-0 rounded-lg bg-v2-background-bg-layer-01 px-3 py-2.5">
      <div class="text-[10px] font-medium uppercase tracking-[0.1em] text-v2-text-text-faint">{props.label}</div>
      <div class="mt-1 truncate text-[13px] font-semibold tabular-nums text-v2-text-text-base">{props.value}</div>
    </div>
  )
}

const emptyMessages: SessionMessage[] = []

export function SessionContextTab() {
  const sync = useSync()
  const serverSync = useServerSync()
  const language = useLanguage()
  const sdk = useSDK()
  const global = useGlobal()
  const server = useServer()
  const providers = useProviders(() => sdk().directory)
  const models = useModels()
  const local = useLocal()
  const { params, view } = useSessionLayout()

  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))

  const messages = createMemo<readonly SessionMessage[]>(() => {
    const id = params.id
    if (!id) return emptyMessages
    return serverSync().nativeMessages.messages(id) ?? emptyMessages
  })

  const ctx = createMemo(() => getSessionContext(messages(), [...providers.all().values()], providers.model))
  const tokens = createMemo(() => info()?.tokens)
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))
  const compactions = createMemo(() => sessionCompactionEvents(messages()))
  const [showCompactions, setShowCompactions] = createSignal(false)
  const [compacting, setCompacting] = createSignal(false)

  const compactNow = async () => {
    const sessionID = params.id
    if (!sessionID || compacting()) return
    setCompacting(true)
    try {
      await sdk().client.v2.session.compact({ sessionID })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setCompacting(false)
    }
  }

  const counts = createMemo(() => {
    const all = messages()
    const user = all.reduce((count, x) => count + (x.type === "user" ? 1 : 0), 0)
    const assistant = all.reduce((count, x) => count + (x.type === "assistant" ? 1 : 0), 0)
    return {
      all: all.length,
      user,
      assistant,
    }
  })

  // Native transcripts carry the injected/updated system context as `system` messages
  // (from `session.next.context.updated`); surface the most recent one. The full resolved base
  // prompt is server-side session state (F1e deep-tail #2) — sourcing it needs a dedicated endpoint.
  const systemPrompt = createMemo(() => {
    const msg = findLast(messages(), (m) => m.type === "system")
    const system = msg?.type === "system" ? msg.text : undefined
    const trimmed = system?.trim()
    if (!trimmed) return
    return trimmed
  })

  const rosterCtx = createMemo(() => {
    const connection = server.current
    return connection ? global.ensureServerCtx(connection) : undefined
  })
  const officerID = createMemo(() => info()?.agent ?? ctx()?.message.agent)
  const officer = createMemo(() =>
    rosterCtx()
      ?.agents.list()
      .find((agent) => agent.id === officerID()),
  )
  const officerName = createMemo(() => {
    const row = officer()
    if (row?.name?.trim()) return row.name.trim()
    const id = officerID()
    return id ? displayName(id) : (info()?.title ?? params.id ?? "—")
  })
  const modelLabel = createMemo(() => {
    const current = ctx()
    // 🔴 A SWITCHED-OFF MODEL MUST NOT BE NAMED (owner, 2026-09-16: *"clicking the context indicator
    // ring still shows the old model, despite it being disabled"*). `ctx().modelLabel` is the model
    // that produced the LAST reply, which is the right answer while that model is still runnable —
    // but once it is switched off the runner substitutes another, so naming it describes a model that
    // cannot answer. Prefer the model this session will actually run next (`local.model.current()`,
    // which now resolves through `models.enabled`).
    const historical = current?.message.model
    const historicalEnabled =
      historical === undefined || models.enabled({ providerID: historical.providerID, modelID: historical.id })
    if (current && historicalEnabled) return current.modelLabel
    const effective = local.model.current()
    if (effective) return effective.name
    if (current) return current.modelLabel
    const assigned = info()?.model ?? officer()?.model
    if (!assigned) return "—"
    return providers.model(assigned.providerID, assigned.id)?.name ?? assigned.id
  })

  const breakdown = createMemo(
    on(
      () => [ctx()?.message.id, ctx()?.input, messages().length, systemPrompt()],
      () => {
        const c = ctx()
        if (!c?.input) return []
        return estimateSessionContextBreakdown({
          messages: messages(),
          input: c.input,
          systemPrompt: systemPrompt(),
        })
      },
    ),
  )

  const breakdownLabel = (key: SessionContextBreakdownKey) => {
    if (key === "system") return language.t("context.breakdown.system")
    if (key === "user") return language.t("context.breakdown.user")
    if (key === "assistant") return language.t("context.breakdown.assistant")
    if (key === "tool") return language.t("context.breakdown.tool")
    return language.t("context.breakdown.other")
  }

  const contextRemaining = createMemo(() => {
    const current = ctx()
    if (!current?.limit) return 0
    return Math.max(0, current.limit - current.total)
  })
  const contextAvailablePercent = createMemo(() => {
    const current = ctx()
    if (!current?.limit) return undefined
    return Math.max(0, 100 - Math.min(100, current.usage ?? 0))
  })
  const segmentCapacityWeight = (tokens: number) => {
    const current = ctx()
    if (!current?.input) return tokens
    return tokens * (current.total / current.input)
  }

  const exportSegment = (key: SessionContextBreakdownKey, estimatedTokens: number) => {
    downloadPlainText(
      sessionExportFilename(officerName(), `${key}-context`),
      serializeContextSegment({ key, messages: messages(), estimatedTokens }),
    )
  }

  const exportTranscript = () => {
    downloadPlainText(sessionExportFilename(officerName(), "transcript"), serializeSessionTranscript(messages()))
  }

  let scroll: HTMLDivElement | undefined
  let frame: number | undefined
  let pending: { x: number; y: number } | undefined

  const restoreScroll = () => {
    const el = scroll
    if (!el) return

    const s = view().scroll("context")
    if (!s) return

    if (el.scrollTop !== s.y) el.scrollTop = s.y
    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    pending = {
      x: event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    }
    if (frame !== undefined) return

    frame = requestAnimationFrame(() => {
      frame = undefined

      const next = pending
      pending = undefined
      if (!next) return

      view().setScroll("context", next)
    })
  }

  createEffect(
    on(
      () => messages().length,
      () => {
        requestAnimationFrame(restoreScroll)
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
  })

  return (
    <ScrollView
      class="@container h-full"
      viewportRef={(el) => {
        scroll = el
        restoreScroll()
      }}
      onScroll={handleScroll}
    >
      <div class="px-6 pt-4 pb-10 flex flex-col gap-8">
        <section
          data-slot="context-identity"
          class="relative overflow-hidden rounded-2xl border border-v2-border-border-base bg-v2-background-bg-layer-02 p-5 shadow-[var(--v2-elevation-raised)]"
        >
          <div
            aria-hidden="true"
            class="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-v2-border-border-focus to-transparent opacity-80"
          />
          <div class="flex items-center gap-4">
            <AgentPortrait
              id={officerID() ?? "session"}
              name={officerName()}
              avatar={officer()?.avatar}
              background={agentColor(officerID() ?? officerName(), officer()?.color)}
              class="size-14 border border-v2-border-border-strong text-xl font-semibold shadow-[var(--v2-elevation-raised)]"
            />
            <div class="min-w-0 flex-1">
              <h2 class="truncate text-xl font-semibold tracking-[-0.02em] text-v2-text-text-base">{officerName()}</h2>
              <div class="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] text-v2-text-text-muted">
                <Icon name="brain" class="size-3.5 shrink-0 text-v2-icon-icon-base" />
                <span class="truncate">{modelLabel()}</span>
              </div>
            </div>
          </div>

          <div class="mt-5 grid grid-cols-1 gap-3 @[30rem]:grid-cols-2">
            <div class="rounded-xl border border-v2-border-border-base bg-v2-background-bg-base/40 p-4">
              <div class="text-[11px] font-medium uppercase tracking-[0.12em] text-v2-text-text-faint">
                {language.t("context.stats.messages")}
              </div>
              <div class="mt-1 text-2xl font-semibold tabular-nums text-v2-text-text-base">
                {counts().all.toLocaleString(language.intl())}
              </div>
              <div class="mt-3 grid grid-cols-2 gap-2">
                <Detail
                  label={language.t("context.messages.you")}
                  value={counts().user.toLocaleString(language.intl())}
                />
                <Detail label={officerName()} value={counts().assistant.toLocaleString(language.intl())} />
              </div>
            </div>

            <div class="rounded-xl border border-v2-border-border-base bg-v2-background-bg-base/40 p-4">
              <div class="text-[11px] font-medium uppercase tracking-[0.12em] text-v2-text-text-faint">
                {language.t("context.tokens.title")}
              </div>
              <div class="mt-1 text-2xl font-semibold tabular-nums text-v2-text-text-base">
                {formatter().number(getSessionTokenTotal(tokens()))}
              </div>
              <div class="mt-3 grid grid-cols-2 gap-2 @[38rem]:grid-cols-3">
                <Detail label={language.t("context.tokens.input")} value={formatter().number(tokens()?.input)} />
                <Detail label={language.t("context.tokens.output")} value={formatter().number(tokens()?.output)} />
                <Detail
                  label={language.t("context.tokens.reasoning")}
                  value={formatter().number(tokens()?.reasoning)}
                />
                <Detail
                  label={language.t("context.tokens.cacheRead")}
                  value={formatter().number(tokens()?.cache.read)}
                />
                <Detail
                  label={language.t("context.tokens.cacheWrite")}
                  value={formatter().number(tokens()?.cache.write)}
                />
              </div>
            </div>
          </div>

          <div class="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-v2-text-text-faint">
            <span>
              {language.t("context.meta.created")} {formatter().time(info()?.time.created)}
            </span>
            <span>
              {language.t("context.meta.active")} {formatter().time(ctx()?.message.time.created)}
            </span>
          </div>
        </section>

        <Show when={breakdown().length > 0}>
          <section
            data-slot="context-breakdown"
            class="rounded-2xl border border-v2-border-border-base bg-v2-background-bg-layer-01 p-4"
          >
            <div class="flex items-end justify-between gap-4">
              <div>
                <h3 class="text-[13px] font-semibold text-v2-text-text-base">
                  {language.t("context.breakdown.title")}
                </h3>
                <div class="mt-1 text-[11px] text-v2-text-text-faint">{language.t("context.breakdown.note")}</div>
              </div>
              <div class="shrink-0 text-right">
                <div class="text-xl font-semibold tabular-nums text-v2-text-text-base">
                  {formatter().percent(ctx()?.usage)}
                </div>
                <div class="text-[11px] tabular-nums text-v2-text-text-faint">
                  {language.t("context.breakdown.capacity", {
                    used: formatter().number(ctx()?.total),
                    limit: formatter().number(ctx()?.limit),
                  })}
                </div>
              </div>
            </div>

            <div class="mt-4 w-full overflow-x-auto rounded-xl border border-v2-border-border-base bg-v2-background-bg-base/60">
              <div
                class="flex h-16 w-full overflow-hidden rounded-[11px]"
                style={{ "min-width": `max(100%, ${breakdown().length * 84}px)` }}
              >
                <For each={breakdown()}>
                  {(segment) => (
                    <button
                      type="button"
                      data-context-segment={segment.key}
                      class="group relative min-w-[5.25rem] cursor-pointer border-r border-v2-border-border-base px-2 text-left outline-none transition-[filter] hover:brightness-125 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-v2-border-border-focus"
                      style={{
                        "flex-basis": "0px",
                        "flex-grow": String(segmentCapacityWeight(segment.tokens)),
                        background: `linear-gradient(180deg, color-mix(in oklab, ${BREAKDOWN_COLOR[segment.key]} 34%, var(--v2-background-bg-layer-02)), color-mix(in oklab, ${BREAKDOWN_COLOR[segment.key]} 15%, var(--v2-background-bg-base)))`,
                      }}
                      title={language.t("context.breakdown.export", { label: breakdownLabel(segment.key) })}
                      aria-label={language.t("context.breakdown.export", { label: breakdownLabel(segment.key) })}
                      onClick={() => exportSegment(segment.key, segment.tokens)}
                    >
                      <span
                        aria-hidden="true"
                        class="absolute inset-x-0 top-0 h-1"
                        style={{ "background-color": BREAKDOWN_COLOR[segment.key] }}
                      />
                      <span class="block truncate text-[11px] font-semibold text-v2-text-text-base">
                        {breakdownLabel(segment.key)}
                      </span>
                      <span class="mt-0.5 block text-[11px] tabular-nums text-v2-text-text-muted">
                        {segment.percent.toLocaleString(language.intl())}% · {formatter().number(segment.tokens)}
                      </span>
                      <Icon
                        name="download"
                        class="absolute bottom-2 right-2 size-3 text-v2-icon-icon-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                      />
                    </button>
                  )}
                </For>
                <Show when={contextRemaining() > 0}>
                  <div
                    class="flex min-w-0 items-center justify-center bg-v2-background-bg-layer-01 px-2 text-[10px] font-medium uppercase tracking-[0.08em] text-v2-text-text-faint"
                    style={{ "flex-basis": "0px", "flex-grow": String(contextRemaining()) }}
                  >
                    <Show when={(contextAvailablePercent() ?? 0) >= 8}>
                      {language.t("context.breakdown.available")} {formatter().percent(contextAvailablePercent())}
                    </Show>
                  </div>
                </Show>
              </div>
            </div>
            <div class="mt-2 flex items-center gap-1.5 text-[10px] text-v2-text-text-faint">
              <Icon name="download" class="size-3" />
              {language.t("context.breakdown.exportHint")}
            </div>
          </section>
        </Show>

        <div class="flex flex-col gap-3">
          <div class="flex flex-wrap gap-2">
            <ButtonV2 type="button" variant="gold" disabled={compacting()} onClick={() => void compactNow()}>
              {language.t(compacting() ? "context.compactions.compacting" : "context.compactions.compactNow")}
            </ButtonV2>
            <ButtonV2 type="button" variant="outline" onClick={() => setShowCompactions((value) => !value)}>
              {language.t("context.compactions.button")} ({compactions().length.toLocaleString(language.intl())})
            </ButtonV2>
          </div>
          <Show when={showCompactions()}>
            <div class="flex flex-col gap-2" aria-label={language.t("context.compactions.title")}>
              <Show
                when={compactions().length > 0}
                fallback={<div class="text-12-regular text-text-weak">{language.t("context.compactions.empty")}</div>}
              >
                <For each={compactions()}>
                  {(event) => (
                    <div class="rounded-md border border-border-base bg-surface-base px-3 py-2 flex flex-col gap-1">
                      <div class="flex items-center justify-between gap-3">
                        <div class="text-12-medium text-text-strong">
                          {language.t(`context.compactions.cause.${event.cause}`)}
                        </div>
                        <div class="text-11-regular text-text-weak">{formatter().time(event.at)}</div>
                      </div>
                      <div class="text-12-regular text-text-base">
                        {event.beforeTokens === undefined
                          ? language.t("context.compactions.sizeUnknown")
                          : event.afterTokens === undefined
                            ? `${formatter().number(event.beforeTokens)} ${language.t("context.compactions.tokensBefore")}`
                            : `${formatter().number(event.beforeTokens)} → ${formatter().number(event.afterTokens)} ${language.t("context.compactions.tokens")}`}
                      </div>
                      <div
                        class={
                          event.status === "failed"
                            ? "text-11-regular text-icon-critical-base"
                            : "text-11-regular text-text-weak"
                        }
                      >
                        {language.t(`context.compactions.status.${event.status}`)}
                        {event.failure ? ` · ${event.failure}` : ""}
                      </div>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </Show>
        </div>

        <Show when={systemPrompt()}>
          {(prompt) => (
            <div class="flex flex-col gap-2">
              <div class="text-12-regular text-text-weak">{language.t("context.systemPrompt.title")}</div>
              <div class="border border-border-base rounded-md bg-surface-base px-3 py-2">
                <Markdown text={prompt()} class="text-12-regular" />
              </div>
            </div>
          )}
        </Show>

        <div>
          <ButtonV2 type="button" variant="gold" icon="download" onClick={exportTranscript}>
            {language.t("context.export.transcript")}
          </ButtonV2>
        </div>
      </div>
    </ScrollView>
  )
}
