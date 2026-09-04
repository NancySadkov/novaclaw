import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { reportedWrite } from "@/utils/config-write"
import { showToast } from "@/utils/toast"

/**
 * The settings-wide write door for controls that persist immediately.
 *
 * A controlled switch/select reads its value from the synced config, so a rejected write already
 * rolls the control back to the last confirmed value. This hook owns the other half of that
 * contract: the rejection is always made visible. Keeping both General and Recovery on this door
 * prevents a new immediate control from quietly inventing another failure policy.
 */
export function useSettingsConfigWrite() {
  const language = useLanguage()
  const serverSync = useServerSync()

  return (patch: Record<string, unknown>) =>
    reportedWrite(
      () => serverSync().updateConfig(patch as never),
      (description) =>
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description,
        }),
    )
}
