import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import type { Component } from "solid-js"
import { showToast } from "@/utils/toast"
import { formatServerError } from "@/utils/server-errors"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { useConfirm } from "@/components/dialog-confirm"
import { RequiresLevel } from "@/context/expertise"

// Raw whole-config Export/Import — a Developer affordance (uix.md §6.4). Lifted out of the (removed)
// Providers tab into the merged Models tab so config portability survives the merge. Desktop-only:
// window.api (the file pickers) is absent on web, so the buttons no-op there.
//
// Config→SQLite step 8: the export is the COMPLETE effective config — the server's /config view
// overlays every SQLite store (settings + folded provider/agent/command/reference layers +
// skills/plugins), so this document is the full settings wire format an Import on another
// instance re-seeds from. Only derived/transport noise is dropped.
const EXPORT_DROP_KEYS = new Set(["$schema", "plugin_origins"])

function generateConfigTemplate(current: Record<string, unknown>): string {
  const out: Record<string, unknown> = { $schema: "https://novaclaw.app/config.json" }
  for (const [key, value] of Object.entries(current)) {
    if (value === undefined || EXPORT_DROP_KEYS.has(key)) continue
    out[key] = value
  }
  return JSON.stringify(out, null, 2) + "\n"
}

export function parseJSONC(content: string): Record<string, unknown> | null {
  try {
    const stripped = content.replace(/(?<!:)\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
    return JSON.parse(stripped)
  } catch {
    return null
  }
}

export const ConfigExportImport: Component = () => {
  const language = useLanguage()
  const serverSync = useServerSync()
  const confirm = useConfirm()

  const exportConfig = async () => {
    const jsonc = generateConfigTemplate(serverSync().data.config as Record<string, unknown>)
    const api = (window as unknown as { api?: Record<string, (...args: never[]) => Promise<unknown>> }).api
    if (!api?.saveFilePicker || !api?.writeFile) return
    const path = (await api.saveFilePicker({
      title: language.t("settings.providers.export.dialogTitle"),
      defaultPath: "novaclaw.jsonc",
    } as never)) as string | undefined
    if (!path) return
    await api.writeFile(path as never, jsonc as never)
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("settings.providers.export.toast"),
      description: path,
    })
  }

  const importConfig = async () => {
    const api = (window as unknown as { api?: Record<string, (...args: never[]) => Promise<unknown>> }).api
    if (!api?.openFilePicker || !api?.readPickedFile) return
    const result = (await api.openFilePicker({
      title: language.t("settings.providers.import.dialogTitle"),
      extensions: ["jsonc", "json"],
    } as never)) as { token: string; files: { path: string }[] } | undefined
    if (!result?.files?.length) return
    const buf = (await api.readPickedFile(result.token as never, result.files[0].path as never)) as ArrayBuffer
    const parsed = parseJSONC(new TextDecoder().decode(buf))
    if (!parsed) {
      showToast({
        variant: "error",
        title: language.t("settings.providers.import.invalid.title"),
        description: language.t("settings.providers.import.invalid.description"),
      })
      return
    }
    const proceed = await confirm({
      title: language.t("settings.providers.import.confirm.title"),
      description: language.t("settings.providers.import.confirm.description"),
      confirmLabel: language.t("settings.providers.import.confirm.action"),
    })
    if (!proceed) return
    const ok = await serverSync()
      .updateConfig(parsed as never)
      .then(() => true)
      .catch((err: unknown) => {
        // Render the server's ConfigInvalidError through the friendly parser (path + per-issue
        // "key: message" lines) instead of a raw error string — so a bad key reads as guidance.
        showToast({
          variant: "error",
          title: language.t("settings.providers.import.failed"),
          description: formatServerError(err, language.t),
        })
        return false
      })
    if (!ok) return
    showToast({ variant: "success", icon: "circle-check", title: language.t("settings.providers.import.toast") })
  }

  return (
    <RequiresLevel min="developer">
      <div class="flex gap-2">
        <ButtonV2 size="small" variant="neutral" onClick={() => void exportConfig()}>
          {language.t("settings.config.io.export")}
        </ButtonV2>
        <ButtonV2 size="small" variant="neutral" onClick={() => void importConfig()}>
          {language.t("settings.config.io.import")}
        </ButtonV2>
      </div>
    </RequiresLevel>
  )
}
