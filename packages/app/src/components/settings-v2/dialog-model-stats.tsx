import { type Component, Show } from "solid-js"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useLanguage } from "@/context/language"
import type { ServerConnection } from "@/context/server"
import { createSettledResource } from "@/utils/settled-resource"
import { fetchUsage } from "@/utils/usage-api"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { classify, taxonomyLabel } from "../model-taxonomy"

const integer = (value: number) => Math.round(value).toLocaleString()
const rate = (value: number | undefined) => (value === undefined ? "—" : `${value.toFixed(1)} tok/s`)

export const DialogModelStats: Component<{
  http: ServerConnection.HttpBase
  modelRef: string
  modelName: string
  /** The model's class (`smart` | `usual` | `fast`); absent reads as the default, Usual. */
  taxonomy?: string
  prefixCache?: { readonly enabled: boolean; readonly ttlMinutes?: number }
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const [summary] = createSettledResource(
    () => props.http,
    (http) => fetchUsage(http),
  )
  const usage = () => summary()?.modelUsage?.[props.modelRef]
  const cacheShare = () => {
    const data = usage()?.prefixCache
    if (!data || data.promptBytes === 0) return undefined
    return (data.matchedPrefixBytes / data.promptBytes) * 100
  }

  return (
    <Dialog size="content">
      <div class="flex w-[min(34rem,calc(100vw-32px))] max-w-full flex-col gap-4 px-7 py-7">
        <div class="flex flex-col gap-1 text-center">
          <span class="text-[17px] font-semibold text-v2-text-text-base">
            {language.t("settings.models.stats.title", { model: props.modelName })}
          </span>
          <span class="text-[13px] text-v2-text-text-muted">{language.t("settings.models.stats.description")}</span>
        </div>

        <Show when={!summary.loading} fallback={<p>{language.t("common.loading")}</p>}>
          <Show
            when={!summary.failed}
            fallback={<p class="text-sm text-v2-state-fg-danger">{language.t("settings.models.stats.failed")}</p>}
          >
            <SettingsListV2>
              <SettingsRowV2
                title={language.t("settings.models.stats.generated")}
                description={language.t("settings.models.stats.generated.desc")}
              >
                <span>{integer(usage()?.tokens?.output ?? 0)}</span>
              </SettingsRowV2>
              <SettingsRowV2
                title={language.t("settings.models.stats.prompts")}
                description={language.t("settings.models.stats.prompts.desc")}
              >
                <span>{integer(usage()?.messages ?? 0)}</span>
              </SettingsRowV2>
              <SettingsRowV2
                title={language.t("settings.models.stats.outputRate")}
                description={language.t("settings.models.stats.outputRate.desc")}
              >
                <span>{rate(usage()?.typical?.outputTokensPerSecond)}</span>
              </SettingsRowV2>
              <SettingsRowV2
                title={language.t("settings.models.stats.promptRate")}
                description={language.t("settings.models.stats.promptRate.desc")}
              >
                <span>{rate(usage()?.typical?.promptTokensPerSecond)}</span>
              </SettingsRowV2>
              <SettingsRowV2
                title={language.t("settings.models.stats.ttft")}
                description={language.t("settings.models.stats.ttft.desc")}
              >
                <span>
                  {usage()?.typical?.timeToFirstTokenMs === undefined
                    ? "—"
                    : `${Math.round(usage()!.typical.timeToFirstTokenMs!)} ms`}
                </span>
              </SettingsRowV2>
              <SettingsRowV2
                title={language.t("settings.models.stats.cacheActual")}
                description={language.t("settings.models.stats.cacheActual.desc")}
              >
                <span>{integer(usage()?.tokens?.cache?.read ?? 0)}</span>
              </SettingsRowV2>
              <SettingsRowV2
                title={language.t("settings.models.stats.cacheExpected")}
                description={
                  props.prefixCache?.enabled
                    ? language.t("settings.models.stats.cacheExpected.on", {
                        minutes: props.prefixCache.ttlMinutes ?? 5,
                      })
                    : language.t("settings.models.stats.cacheExpected.off")
                }
              >
                <span>{integer(usage()?.prefixCache?.expectedCachedTokens ?? 0)}</span>
              </SettingsRowV2>
              <SettingsRowV2
                title={language.t("settings.models.stats.prefixBytes")}
                description={language.t("settings.models.stats.prefixBytes.desc")}
              >
                <span>
                  {cacheShare() === undefined
                    ? "—"
                    : `${integer(usage()!.prefixCache.matchedPrefixBytes)} · ${cacheShare()!.toFixed(1)}%`}
                </span>
              </SettingsRowV2>
              <SettingsRowV2
                title={language.t("settings.models.stats.taxonomy")}
                info={language.t("settings.models.stats.taxonomy.desc")}
              >
                <span>
                  {taxonomyLabel(language.t, classify(props.taxonomy))}
                  {props.taxonomy === undefined ? ` · ${language.t("settings.models.stats.taxonomy.unrated")}` : ""}
                </span>
              </SettingsRowV2>
            </SettingsListV2>
          </Show>
        </Show>

        <div class="flex justify-end">
          <ButtonV2 variant="gold" onClick={() => dialog.close()}>
            {language.t("common.close")}
          </ButtonV2>
        </div>
      </div>
    </Dialog>
  )
}
