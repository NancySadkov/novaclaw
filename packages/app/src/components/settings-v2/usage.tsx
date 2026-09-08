import { type Component, createMemo, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { createSettledResource } from "@/utils/settled-resource"
import { fetchUsage } from "@/utils/usage-api"

/**
 * Settings → Usage: what this instance has spent, in tokens and money.
 *
 * 🔴 **The numbers existed only on the CLI until 2026-09-04** (`nova-cli stats`, 400 lines of ASCII
 * bar charts), which principle 7 rules out: the HTML UI is the product and the CLI is headless-only,
 * so an analytics dashboard belongs in the shell. Deleting the command without this would have
 * removed token and cost reporting from the product entirely, which is the "we would lose a
 * capability" shape principle 1 names — so the page comes first and the command goes after.
 *
 * ⚠️ A Settings TAB rather than a home tile, following the decision recorded in `apps/builtins.tsx`:
 * Models and Devices are Settings tabs, and *"every tile is a promise"* — a launcher tile is for
 * something you go and DO, not a report you occasionally consult.
 */
const WINDOWS = [7, 30, 90] as const

/** `undefined` is all-time. Never 0 — a window of zero days asks for nothing (see `usage-api.ts`). */
type Window = (typeof WINDOWS)[number] | undefined

const number = (value: number) => Math.round(value).toLocaleString()

const money = (value: number) => `$${value.toFixed(2)}`

export const SettingsUsageV2: Component = () => {
  const language = useLanguage()
  const server = useServer()
  const [window, setWindow] = createSignal<Window>(undefined)

  /**
   * 🔴 `createSettledResource`, never a bare `createResource` — the rule
   * `utils/settled-resource-ledger.test.ts` exists to keep. An errored resource THROWS from its own
   * accessor, so an unguarded read hands the failure to the root ErrorBoundary and replaces the
   * whole application (`nova-health.tsx` records that incident). `initialValue` does not save it and
   * makes it worse: it erases the difference between *not asked* and *answered with nothing*.
   *
   * The helper keeps the three apart — `idle`, `failed`, and a value — which is exactly what this
   * panel needs to obey ruling 2's second half. I hand-rolled that distinction with a `failed`
   * signal first; the ledger caught it, and the type is better than the hand-roll because the next
   * reader cannot lose it in a render expression.
   */
  const [summary] = createSettledResource(
    () => {
      const http = server.current?.http
      return http ? { http, days: window() } : undefined
    },
    (input) => fetchUsage(input.http, { days: input.days }),
  )

  const models = createMemo(() =>
    Object.entries(summary()?.modelUsage ?? {}).sort(([, a], [, b]) => b.cost - a.cost || b.messages - a.messages),
  )
  const tools = createMemo(() =>
    Object.entries(summary()?.toolUsage ?? {})
      .sort(([, a], [, b]) => b - a)
      .slice(0, 12),
  )
  /** An instance nobody has used yet is a first-run STATE, not an error — say so rather than showing zeros. */
  const empty = createMemo(() => !summary.failed && summary() !== undefined && summary()!.totalSessions === 0)

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.usage.title")}</h2>
      </div>

      <div class="settings-v2-tab-body">
        <p class="settings-v2-field-description">{language.t("settings.usage.description")}</p>

        <div class="flex flex-wrap items-center gap-2" data-slot="usage-windows">
          <For each={[undefined, ...WINDOWS] as Window[]}>
            {(value) => (
              <button
                type="button"
                data-slot="usage-window"
                data-active={window() === value ? "" : undefined}
                class="rounded-md border border-v2-border-border-muted px-2 py-1 text-[12px] data-active:border-v2-border-border-base data-active:text-v2-text-text-base text-v2-text-text-muted"
                onClick={() => setWindow(value)}
              >
                {value === undefined
                  ? language.t("settings.usage.window.all")
                  : language.t("settings.usage.window.days", { days: String(value) })}
              </button>
            )}
          </For>
        </div>

        <Show when={summary.failed}>
          {/* Ruling 2 — an unavailable subsystem NAMES itself instead of rendering empty. */}
          <p class="settings-v2-field-description" data-slot="usage-unreachable">
            {language.t("settings.usage.unreachable")}
          </p>
        </Show>

        <Show when={empty()}>
          <p class="settings-v2-field-description" data-slot="usage-empty">
            {language.t("settings.usage.empty")}
          </p>
        </Show>

        <Show when={!summary.failed && !empty() && summary()}>
          {(data) => (
            <>
              <div class="settings-v2-section" data-slot="usage-totals">
                <h3 class="settings-v2-section-title">{language.t("settings.usage.totals")}</h3>
                <ul class="flex flex-col gap-1 text-[12px]">
                  <For
                    each={
                      [
                        ["settings.usage.sessions", number(data().totalSessions)],
                        ["settings.usage.messages", number(data().totalMessages)],
                        ["settings.usage.cost", money(data().totalCost)],
                        ["settings.usage.costPerDay", money(data().costPerDay)],
                        ["settings.usage.tokensIn", number(data().totalTokens.input)],
                        ["settings.usage.tokensOut", number(data().totalTokens.output)],
                        ["settings.usage.cacheRead", number(data().totalTokens.cache.read)],
                        ["settings.usage.tokensPerSession", number(data().tokensPerSession)],
                      ] as const
                    }
                  >
                    {([key, value]) => (
                      <li class="flex justify-between gap-4" data-slot="usage-row">
                        <span class="text-v2-text-text-muted">{language.t(key)}</span>
                        <span class="text-v2-text-text-base tabular-nums">{value}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </div>

              <Show when={models().length > 0}>
                <div class="settings-v2-section" data-slot="usage-models">
                  <h3 class="settings-v2-section-title">{language.t("settings.usage.byModel")}</h3>
                  <ul class="flex flex-col gap-1 text-[12px]">
                    <For each={models()}>
                      {([id, usage]) => (
                        <li class="flex justify-between gap-4" data-slot="usage-model">
                          <span class="text-v2-text-text-muted break-all">{id}</span>
                          <span class="text-v2-text-text-base tabular-nums whitespace-nowrap">
                            {money(usage.cost)} · {number(usage.messages)}
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>

              <Show when={tools().length > 0}>
                <div class="settings-v2-section" data-slot="usage-tools">
                  <h3 class="settings-v2-section-title">{language.t("settings.usage.byTool")}</h3>
                  <ul class="flex flex-col gap-1 text-[12px]">
                    <For each={tools()}>
                      {([name, count]) => (
                        <li class="flex justify-between gap-4" data-slot="usage-tool">
                          <span class="text-v2-text-text-muted break-all">{name}</span>
                          <span class="text-v2-text-text-base tabular-nums">{number(count)}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>
            </>
          )}
        </Show>
      </div>
    </>
  )
}
