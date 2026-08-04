import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import type { Component } from "solid-js"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { useConfirm } from "@/components/dialog-confirm"
import { RequiresLevel } from "@/context/expertise"
import { parseJSONC } from "./config-io"

// T12 (small-tails): the curated MODEL-BUNDLE Export/Import — a portable "model setup" users hand
// between instances (provider access points + model parameters), distinct from the Developer-gated
// whole-config Export/Import beside it. Secrets never travel: any key/token/authorization-shaped
// field and every `headers` object is stripped on export — this includes the provider-import
// flow's inline `request.body.apiKey` (keys stay per-instance; an imported provider may need
// reconnecting, which is correct). Import merges through the same updateConfig patch path the
// config Import uses. Advanced+ (a portability power tool), desktop-only (window.api file
// pickers are absent on web).

const SECRET_KEY = /key|token|secret|authorization|password|credential/i

/** Deep-copy `value` dropping secret-named fields and whole `headers` objects. */
export function sanitizeModelBundle(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeModelBundle)
  if (value === null || typeof value !== "object") return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) continue
    if (key === "headers") continue
    out[key] = sanitizeModelBundle(entry)
  }
  return out
}

export const ModelBundleIO: Component = () => {
  const language = useLanguage()
  const serverSync = useServerSync()
  const confirm = useConfirm()

  const exportModels = async () => {
    const config = serverSync().data.config as { providers?: Record<string, unknown> }
    const providers = sanitizeModelBundle(config.providers ?? {})
    const bundle = JSON.stringify({ providers }, null, 2) + "\n"
    const api = (window as unknown as { api?: Record<string, (...args: never[]) => Promise<unknown>> }).api
    if (!api?.saveFilePicker || !api?.writeFile) return
    const path = (await api.saveFilePicker({
      title: language.t("settings.providers.export.dialogTitle"),
      defaultPath: "novaclaw-models.json",
    } as never)) as string | undefined
    if (!path) return
    await api.writeFile(path as never, bundle as never)
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("settings.providers.export.toast"),
      description: path,
    })
  }

  const importModels = async () => {
    const api = (window as unknown as { api?: Record<string, (...args: never[]) => Promise<unknown>> }).api
    if (!api?.openFilePicker || !api?.readPickedFile) return
    const result = (await api.openFilePicker({
      title: language.t("settings.providers.import.dialogTitle"),
      extensions: ["json", "jsonc"],
    } as never)) as { token: string; files: { path: string }[] } | undefined
    if (!result?.files?.length) return
    const buf = (await api.readPickedFile(result.token as never, result.files[0].path as never)) as ArrayBuffer
    const parsed = parseJSONC(new TextDecoder().decode(buf))
    const providers = parsed?.providers
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
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
    // Re-sanitize on import too: a hand-edited bundle must not smuggle credential fields into config.
    const ok = await serverSync()
      .updateConfig({ providers: sanitizeModelBundle(providers) } as never)
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
    <RequiresLevel min="advanced">
      <div class="flex gap-2">
        <ButtonV2 size="small" variant="neutral" onClick={() => void exportModels()}>
          {language.t("settings.models.io.export")}
        </ButtonV2>
        <ButtonV2 size="small" variant="neutral" onClick={() => void importModels()}>
          {language.t("settings.models.io.import")}
        </ButtonV2>
      </div>
    </RequiresLevel>
  )
}
