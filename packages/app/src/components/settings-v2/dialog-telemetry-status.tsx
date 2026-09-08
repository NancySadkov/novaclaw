import { For, Show, type Component } from "solid-js"
import type { V2TelemetryStatusResponses } from "@novaclaw/sdk/v2/types"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useLanguage } from "@/context/language"

export type TelemetryStatus = V2TelemetryStatusResponses[200]

export const DialogTelemetryStatus: Component<{ status: TelemetryStatus }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const payload = () => JSON.stringify(props.status.payloadPreview ?? {}, null, 2)

  return (
    <Dialog size="content" class="w-[min(calc(100vw-48px),720px)] max-h-[min(82vh,760px)] min-h-0">
      <div class="flex flex-col min-h-0 px-7 py-6 gap-5">
        <div class="flex flex-col gap-1">
          <h1 class="text-[17px] font-semibold text-v2-text-text-base">
            {language.t("settings.telemetryStatus.title")}
          </h1>
          <p class="text-[13px] text-v2-text-text-muted">{language.t("settings.telemetryStatus.description")}</p>
        </div>

        <div class="min-h-0 overflow-y-auto flex flex-col gap-5 pr-1">
          <section class="flex flex-col gap-2">
            <h2 class="text-[13px] font-semibold text-v2-text-text-base">
              {language.t("settings.telemetryStatus.payload")}
            </h2>
            <pre class="overflow-x-auto whitespace-pre rounded-xl bg-v2-background-bg-layer-02 p-4 text-[12px] leading-5 text-v2-text-text-base ring-1 ring-v2-border-border-base">
              {payload()}
            </pre>
          </section>

          <section class="flex flex-col gap-2">
            <h2 class="text-[13px] font-semibold text-v2-text-text-base">
              {language.t("settings.telemetryStatus.fields")}
            </h2>
            <div class="flex flex-col divide-y divide-v2-border-border-base rounded-xl ring-1 ring-v2-border-border-base">
              <For each={props.status.disclosure}>
                {(row) => (
                  <div class="grid grid-cols-[8rem_1fr] gap-3 px-4 py-3 text-[12px]">
                    <div class="font-mono font-semibold text-v2-text-text-base">{row.field}</div>
                    <div class="flex flex-col gap-0.5 text-v2-text-text-muted">
                      <span>{row.meaning}</span>
                      <Show when={row.condition !== "always"}>
                        <span class="italic">{row.condition}</span>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </section>
        </div>

        <div class="flex justify-end">
          <ButtonV2 onClick={() => dialog.close()}>{language.t("common.close")}</ButtonV2>
        </div>
      </div>
    </Dialog>
  )
}
