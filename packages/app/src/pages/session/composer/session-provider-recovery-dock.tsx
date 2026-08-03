import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { Show, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { showToast } from "@/utils/toast"
import type { SessionProviderRecovery } from "./session-provider-recovery"

export function SessionProviderRecoveryDock(props: {
  sessionID: string
  recovery: SessionProviderRecovery
  onResume: () => void
}) {
  const language = useLanguage()
  const sdk = useSDK()
  const [submitting, setSubmitting] = createSignal(false)

  async function resume() {
    if (submitting()) return
    setSubmitting(true)
    try {
      await sdk().client.v2.session.prompt({
        sessionID: props.sessionID,
        prompt: { text: "resume" },
      })
      props.onResume()
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("session.providerRecovery.error"),
        description: error instanceof Error ? error.message : String(error),
      })
      setSubmitting(false)
    }
  }

  return (
    <div class="pb-2">
      <div class="rounded-[10px] border border-warning-base/40 bg-warning-base/10 px-3 py-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0">
          <div class="text-13-medium text-text-strong">{language.t("session.providerRecovery.title")}</div>
          <div class="text-12-regular text-text-weak">
            <Show when={props.recovery.toolProtocol} fallback={language.t("session.providerRecovery.description")}>
              {language.t("session.providerRecovery.toolDescription")}
            </Show>
          </div>
        </div>
        <ButtonV2 size="small" variant="neutral" disabled={submitting()} onClick={() => void resume()}>
          {submitting()
            ? language.t("session.providerRecovery.resuming")
            : language.t("session.providerRecovery.resume")}
        </ButtonV2>
      </div>
    </div>
  )
}
