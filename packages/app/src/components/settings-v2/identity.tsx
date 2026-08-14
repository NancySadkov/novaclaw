import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { Show, createMemo, createResource, createSignal, type Component } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { instanceIdentity, instanceIdentityBackup } from "@/utils/identity-api"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"

/**
 * Community P1 — the instance's identity, and the one place a user can back it up.
 *
 * 🔴 This lives in ORDINARY settings, not behind Developer mode, and that placement is the whole
 * point. With no registry there is no password reset: a dead disk without a backup loses the
 * identity, its contacts and its history permanently — the "breaks in your hands" failure a normal
 * person must never meet. Hiding it among the internals would mean the users who most need a backup
 * are exactly the ones who never take one.
 *
 * The panel teaches rather than warns-and-blocks (the mission): it says plainly what the file is,
 * because a user who does not understand that the file IS their instance will store it carelessly.
 */

const BACKUP_FILENAME = "novaclaw-identity.json"

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export const SettingsIdentityV2: Component = () => {
  const language = useLanguage()
  const server = useServer()
  const global = useGlobal()
  // Same connection derivation as the sibling panels — `useSDK()` throws outside its provider, and
  // a settings dialog is outside it.
  const connection = createMemo(() => server.current ?? global.servers.list()[0])
  const [identity] = createResource(connection, (value) => instanceIdentity(value.http))
  const [confirming, setConfirming] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [copied, setCopied] = createSignal(false)

  const networkID = createMemo(() => identity()?.networkID ?? "")

  const copy = () => {
    const value = networkID()
    if (!value) return
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1_500)
    })
  }

  const backup = async () => {
    const current = connection()
    if (!current) return
    setBusy(true)
    try {
      const bundle = await instanceIdentityBackup(current.http)
      downloadText(BACKUP_FILENAME, JSON.stringify(bundle, null, 2))
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section class="flex flex-col gap-2" data-slot="settings-identity">
      <h3 class="settings-v2-section-title">{language.t("settings.identity.title")}</h3>
      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.identity.networkID")}
          description={language.t("settings.identity.networkIDDescription")}
          hint={language.t("settings.identity.networkIDHint")}
        >
          <div class="flex items-center gap-2">
            {/* Selectable: the whole purpose of showing it is that a user can hand it to someone. */}
            <span class="select-text truncate font-mono text-[11px] text-v2-text-text-muted" title={networkID()}>
              {networkID() || "…"}
            </span>
            <ButtonV2 variant="neutral" size="small" disabled={!networkID()} onClick={copy}>
              {copied() ? language.t("settings.identity.copied") : language.t("settings.identity.copy")}
            </ButtonV2>
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.identity.backupTitle")}
          description={language.t("settings.identity.backupDescription")}
          hint={language.t("settings.identity.backupHint")}
        >
          <Show
            when={confirming()}
            fallback={
              <ButtonV2 variant="neutral" size="small" onClick={() => setConfirming(true)}>
                {language.t("settings.identity.backupAction")}
              </ButtonV2>
            }
          >
            {/* A second, explicit press. The file IS the instance, so taking a copy should never be
                one stray click away — and the confirm is where the consequence is stated. */}
            <div class="flex items-center gap-2">
              <span class="text-[11px] text-v2-text-text-muted">{language.t("settings.identity.backupConfirm")}</span>
              <ButtonV2 variant="neutral" size="small" disabled={busy()} onClick={() => void backup()}>
                {busy() ? language.t("settings.identity.backupBusy") : language.t("settings.identity.backupProceed")}
              </ButtonV2>
              <ButtonV2 variant="ghost" size="small" disabled={busy()} onClick={() => setConfirming(false)}>
                {language.t("settings.identity.backupCancel")}
              </ButtonV2>
            </div>
          </Show>
        </SettingsRowV2>
      </SettingsListV2>
    </section>
  )
}
