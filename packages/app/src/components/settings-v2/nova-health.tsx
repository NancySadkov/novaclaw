import { For, Show, createMemo, createResource, type Component } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { instanceDiagnosis, type DiagnosisSignal, type DiagnosisStatus } from "@/utils/resource-api"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"

/**
 * Nova Health — the board a person opens when they already suspect something is broken.
 *
 * The composition lives on the server (`NovaHealth`, served by `GET /diagnosis`); this renders it.
 * Two rules it exists to keep, both easy to undo by accident:
 *
 * 1. **`unknown` is never a tick.** Several readings can legitimately answer "cannot tell" — the
 *    updater flag is unreadable outside the desktop shell, a pressure probe reports `unknown` rather
 *    than guessing. Rendering those as healthy is a false report on the one screen someone opens
 *    when they are already worried, so `unknown` gets its own neutral mark and its own words.
 * 2. **Opening this must not cost anything.** The endpoint deliberately gathers no reading that
 *    egresses, which is why refetching on open is safe here and would not be if a provider probe
 *    were folded in.
 *
 * ⚠️ There is deliberately **no green summary banner**. `overall` can only be as good as its worst
 * row, and a prominent "all good" is exactly the element that would keep saying "all good" if a row
 * ever silently stopped being gathered. The rows are the answer; the headline states the count.
 */

/** Neutral for `unknown` on purpose — an unread probe must not borrow the healthy colour. */
const MARK: Record<DiagnosisStatus, string> = {
  problem: "text-v2-text-text-danger",
  warning: "text-v2-text-text-warning",
  unknown: "text-v2-text-text-muted",
  ok: "text-v2-text-text-muted",
}

const GLYPH: Record<DiagnosisStatus, string> = {
  problem: "!",
  warning: "!",
  unknown: "?",
  ok: "OK",
}

export const NovaHealthBoard: Component = () => {
  const language = useLanguage()
  const server = useServer()
  const global = useGlobal()
  const connection = createMemo(() => server.current ?? global.servers.list()[0])
  const [diagnosis, actions] = createResource(connection, (value) => instanceDiagnosis(value.http))

  // A failed fetch is itself a finding, and saying so beats an empty panel that reads as "nothing
  // wrong". This is the screen where an unexplained blank is the worst possible answer.
  const unreachable = createMemo(() => diagnosis.error !== undefined)

  return (
    <section class="flex flex-col gap-2" data-slot="nova-health">
      <div>
        <h3 class="settings-v2-section-title">{language.t("settings.health.title")}</h3>
        <p class="settings-v2-tab-description">
          <Show when={!diagnosis.loading} fallback={language.t("settings.health.checking")}>
            <Show when={!unreachable()} fallback={language.t("settings.health.unreachable")}>
              {diagnosis()?.headline}
            </Show>
          </Show>
        </p>
      </div>

      <SettingsListV2>
        <For each={diagnosis()?.signals ?? []}>
          {(signal: DiagnosisSignal) => (
            <SettingsRowV2
              title={signal.label}
              // The detail says what is true; the action says what to do. A row with neither is a
              // row that is genuinely fine, so it shows nothing rather than manufactured comfort.
              description={[signal.detail, signal.action].filter(Boolean).join(" ")}
            >
              <span class={`select-text text-[12px] ${MARK[signal.status]}`} data-status={signal.status}>
                {GLYPH[signal.status]}
              </span>
            </SettingsRowV2>
          )}
        </For>
      </SettingsListV2>

      <button
        type="button"
        class="settings-v2-tab-description self-start underline"
        onClick={() => void actions.refetch()}
      >
        {language.t("settings.health.recheck")}
      </button>
    </section>
  )
}
