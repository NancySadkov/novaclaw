import { Component, createMemo, Show } from "solid-js"
import type { Session } from "@novaclaw/sdk/v2/client"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { Icon } from "@novaclaw/ui/icon"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { subtreeRows, tokenTotals } from "@/pages/home-session-meta"
import { sessionTitle } from "@/utils/session-title"

// Chat details sheet (uix-improvement slice 5): everything a user may want to KNOW about a chat —
// its working folder, agent + model, live status, file changes, timestamps, and token usage (this
// chat AND the rollup across its sub-agent threads) — with a one-line explainer so tokens teach
// rather than gatekeep. All values are already on the client Session record; zero new fetches.

const Row: Component<{ label: string; value: string; mono?: boolean }> = (props) => (
  <div class="flex items-baseline gap-3 py-1.5">
    <span class="w-28 shrink-0 text-[12px] text-v2-text-text-faint [font-weight:470]">{props.label}</span>
    <span
      class="min-w-0 flex-1 break-all text-[13px] text-v2-text-text-base [font-weight:470]"
      classList={{ "font-mono text-[12px]": props.mono }}
    >
      {props.value}
    </span>
  </div>
)

export const DialogSessionInfo: Component<{ session: Session; projectName?: string }> = (props) => {
  const language = useLanguage()
  const serverSync = useServerSync()
  const number = createMemo(() => new Intl.NumberFormat(language.intl()))
  const when = createMemo(
    () => new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium", timeStyle: "short" }),
  )

  const threads = createMemo(() => {
    const [childStore] = serverSync().child(props.session.directory, { bootstrap: false })
    return subtreeRows(childStore.session, props.session.id)
  })
  const own = createMemo(() => tokenTotals([props.session]))
  const rollup = createMemo(() => tokenTotals([props.session, ...threads().map((row) => row.session)]))

  const status = createMemo(() => {
    const data = serverSync().session.data
    const waiting =
      (data.permission[props.session.id]?.length ?? 0) > 0 || (data.question[props.session.id]?.length ?? 0) > 0
    if (waiting) return language.t("home.sessions.attention.waiting")
    if (data.session_working(props.session.id)) return language.t("home.sessions.attention.working")
    return language.t("session.info.status.ready")
  })

  const changes = createMemo(() => {
    const summary = props.session.summary
    if (!summary || (summary.files ?? 0) <= 0) return undefined
    return language.t("session.info.changes.value", {
      files: summary.files ?? 0,
      additions: summary.additions ?? 0,
      deletions: summary.deletions ?? 0,
    })
  })

  return (
    <Dialog size="normal">
      <div class="flex w-full min-w-[22rem] max-w-[34rem] flex-col gap-1 p-4">
        <div class="flex items-center gap-2 border-b border-v2-border-border-base pb-2">
          <Icon name="info" size="small" class="text-v2-icon-icon-muted" />
          <span class="grow truncate text-[15px] font-semibold text-v2-text-text-base">
            {sessionTitle(props.session.title) || props.session.id}
          </span>
        </div>
        <div class="flex flex-col pt-1">
          <Row label={language.t("session.info.folder")} value={props.session.directory} mono />
          <Show when={props.session.agent}>
            <Row label={language.t("session.info.agent")} value={props.session.agent!} />
          </Show>
          <Show when={props.session.model?.id}>
            <Row label={language.t("session.info.model")} value={props.session.model!.id} mono />
          </Show>
          <Row label={language.t("session.info.status")} value={status()} />
          <Show when={changes()}>{(value) => <Row label={language.t("session.info.changes")} value={value()} />}</Show>
          <Show when={(props.session.cost ?? 0) > 0}>
            <Row label={language.t("session.info.cost")} value={`$${props.session.cost!.toFixed(4)}`} />
          </Show>
          <Row label={language.t("session.info.created")} value={when().format(props.session.time.created)} />
          <Show when={props.session.time.updated}>
            <Row label={language.t("session.info.updated")} value={when().format(props.session.time.updated)} />
          </Show>
          <div class="mt-2 border-t border-v2-border-border-base pt-2">
            <Row
              label={language.t("session.info.tokens.thisChat")}
              value={language.t("session.info.tokens.value", {
                total: number().format(own().total),
                input: number().format(own().input),
                output: number().format(own().output + own().reasoning),
              })}
            />
            <Show when={threads().length > 0}>
              <Row
                label={language.t("session.info.tokens.withThreads")}
                value={language.t("session.info.tokens.rollup", {
                  total: number().format(rollup().total),
                  threads: threads().length,
                })}
              />
            </Show>
            <p class="pt-1 text-[12px] leading-snug text-v2-text-text-faint">
              {language.t("session.info.tokens.hint")}
            </p>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
