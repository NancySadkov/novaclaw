import { Match, Show, Switch, createMemo } from "solid-js"
import { Tooltip, type TooltipProps } from "@novaclaw/ui/tooltip"
import { ProgressCircle } from "@novaclaw/ui/progress-circle"
import { ProgressCircleV2 } from "@novaclaw/ui/v2/progress-circle-v2"
import { Button } from "@novaclaw/ui/button"
import { IconButtonV2 } from "@novaclaw/ui/v2/icon-button-v2"

import { useFile } from "@/context/file"
import { useLayout } from "@/context/layout"
import { useSync } from "@/context/sync"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { useSDK } from "@/context/sdk"
import { getSessionContext, getSessionTokenTotal } from "@/components/session/session-context-metrics"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createSessionTabs } from "@/pages/session/helpers"

interface SessionContextUsageProps {
  variant?: "button" | "indicator"
  buttonAppearance?: "default" | "v2"
  placement?: TooltipProps["placement"]
}

function openSessionContext(args: {
  view: ReturnType<ReturnType<typeof useLayout>["view"]>
  layout: ReturnType<typeof useLayout>
  tabs: ReturnType<ReturnType<typeof useLayout>["tabs"]>
}) {
  if (!args.view.reviewPanel.opened()) args.view.reviewPanel.open()
  if (args.layout.fileTree.opened() && args.layout.fileTree.tab() !== "all") args.layout.fileTree.setTab("all")
  void args.tabs.open("context")
  args.tabs.setActive("context")
}

export function SessionContextUsage(props: SessionContextUsageProps) {
  const sync = useSync()
  const serverSync = useServerSync()
  const file = useFile()
  const layout = useLayout()
  const language = useLanguage()
  const sdk = useSDK()
  const providers = useProviders(() => sdk().directory)
  const { params, tabs, view } = useSessionLayout()

  const variant = createMemo(() => props.variant ?? "button")
  const buttonAppearance = createMemo(() => props.buttonAppearance ?? "default")
  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? file.tab(tab) : tab),
  })
  const messages = createMemo(() => (params.id ? (serverSync().nativeMessages.messages(params.id) ?? []) : []))
  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
      }),
  )

  const context = createMemo(() => getSessionContext(messages(), [...providers.all().values()], providers.model))
  const tokens = createMemo(() => info()?.tokens)
  const cost = createMemo(() => {
    return usd().format(info()?.cost ?? 0)
  })
  // Visual urgency thresholds (the context gauge): calm below 65%, amber to 85%, red above —
  // "aware of context issues" means the ring changes color before compaction territory.
  const tone = createMemo<"warning" | "danger" | undefined>(() => {
    const usage = context()?.usage ?? 0
    if (usage >= 85) return "danger"
    if (usage >= 65) return "warning"
    return undefined
  })

  const openContext = () => {
    if (!params.id) return

    if (tabState.activeTab() === "context") {
      tabs().close("context")
      return
    }
    openSessionContext({
      view: view(),
      layout,
      tabs: tabs(),
    })
  }

  const circle = () => (
    <div class="flex items-center justify-center">
      <ProgressCircle size={16} strokeWidth={2} percentage={context()?.usage ?? 0} />
    </div>
  )
  const circleV2 = () => (
    <div class="flex items-center justify-center">
      <ProgressCircleV2 percentage={context()?.usage ?? 0} tone={tone()} />
    </div>
  )

  const windowed = createMemo(() => {
    const ctx = context()
    return ctx?.limit ? ctx : undefined
  })

  const tooltipValue = () => (
    <div>
      <Show when={windowed()}>
        {(ctx) => (
          <div class="flex items-center gap-2">
            <span class="text-text-invert-strong">
              {ctx().total.toLocaleString(language.intl())} / {ctx().limit!.toLocaleString(language.intl())}
            </span>
            <span class="text-text-invert-base">{language.t("context.usage.window")}</span>
          </div>
        )}
      </Show>
      <Show when={context()}>
        {(ctx) => (
          <div class="flex items-center gap-2">
            <span class="text-text-invert-strong">{ctx().usage ?? 0}%</span>
            <span class="text-text-invert-base">{language.t("context.usage.usage")}</span>
          </div>
        )}
      </Show>
      <Show when={tokens()}>
        {(value) => (
          <div class="flex items-center gap-2">
            <span class="text-text-invert-strong">
              {getSessionTokenTotal(value())?.toLocaleString(language.intl())}
            </span>
            <span class="text-text-invert-base">{language.t("context.usage.tokens")}</span>
          </div>
        )}
      </Show>
      <div class="flex items-center gap-2">
        <span class="text-text-invert-strong">{cost()}</span>
        <span class="text-text-invert-base">{language.t("context.usage.cost")}</span>
      </div>
    </div>
  )

  return (
    <Show when={params.id}>
      <Tooltip value={tooltipValue()} placement={props.placement ?? "top"}>
        <Switch>
          <Match when={variant() === "indicator"}>{circle()}</Match>
          <Match when={buttonAppearance() === "v2"}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="large"
              icon={circleV2()}
              onClick={openContext}
              aria-label={language.t("context.usage.view")}
            />
          </Match>
          <Match when={true}>
            <Button
              type="button"
              variant="ghost"
              class="size-6"
              onClick={openContext}
              aria-label={language.t("context.usage.view")}
            >
              {circle()}
            </Button>
          </Match>
        </Switch>
      </Tooltip>
    </Show>
  )
}
