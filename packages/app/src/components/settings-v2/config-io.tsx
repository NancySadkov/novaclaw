import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import type { Component } from "solid-js"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { useConfirm } from "@/components/dialog-confirm"
import { RequiresLevel } from "@/context/expertise"

// Raw whole-config Export/Import — a Developer affordance (uix.md §6.4). Lifted out of the (removed)
// Providers tab into the merged Models tab so config portability survives the merge. Desktop-only:
// window.api (the file pickers) is absent on web, so the buttons no-op there.
function generateConfigTemplate(current: Record<string, unknown>): string {
  const out: Record<string, unknown> = { $schema: "https://novaclaw.app/config.json" }
  for (const key of ["model", "shell", "default_agent", "username", "providers", "mcp", "agents", "permissions"]) {
    if (current[key] !== undefined) out[key] = current[key]
  }
  return JSON.stringify(out, null, 2) + "\n"
}

function parseJSONC(content: string): Record<string, unknown> | null {
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
        showToast({
          variant: "error",
          title: language.t("settings.providers.import.failed"),
          description: err instanceof Error ? err.message : String(err),
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
          {language.t("settings.providers.export.action")}
        </ButtonV2>
        <ButtonV2 size="small" variant="neutral" onClick={() => void importConfig()}>
          {language.t("settings.providers.import.action")}
        </ButtonV2>
      </div>
    </RequiresLevel>
  )
}
