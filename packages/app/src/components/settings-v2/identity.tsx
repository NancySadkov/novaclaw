import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { communityRotate } from "@/utils/community-api"
import { Show, createMemo, createResource, createSignal, type Component } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import {
  instanceIdentity,
  instanceIdentityBackup,
  instanceIdentityRestore,
  type IdentityBackup,
} from "@/utils/identity-api"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { SettingsExplainV2 } from "./explain"

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

/**
 * Read a backup file, or `undefined` if it is not one.
 *
 * ⚠️ Checked here rather than trusting the server to refuse: the confirm below names the identity
 * the user is about to BECOME, and a dialog that shows "undefined" while asking for an irreversible
 * decision is worse than no dialog. The server still validates — this is so the question is honest,
 * not so the check happens only once.
 */
function readBackup(text: string): IdentityBackup | undefined {
  try {
    const value = JSON.parse(text) as Partial<IdentityBackup>
    if (value?.version !== 1) return undefined
    if (typeof value.id !== "string" || typeof value.networkID !== "string") return undefined
    if (typeof value.secretKey !== "string" || value.secretKey.length === 0) return undefined
    return value as IdentityBackup
  } catch {
    return undefined
  }
}

export const SettingsIdentityV2: Component = () => {
  const language = useLanguage()
  const server = useServer()
  const global = useGlobal()
  // Same connection derivation as the sibling panels — `useSDK()` throws outside its provider, and
  // a settings dialog is outside it.
  const connection = createMemo(() => server.current ?? global.servers.list()[0])
  const [identity, identityActions] = createResource(connection, (value) => instanceIdentity(value.http))
  const [confirming, setConfirming] = createSignal(false)
  const [rotating, setRotating] = createSignal(false)
  const [rotated, setRotated] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  /** The parsed file, held between choosing it and confirming — the confirm names what it contains. */
  const [pending, setPending] = createSignal<IdentityBackup | undefined>(undefined)
  const [restoreNote, setRestoreNote] = createSignal("")
  let fileInput: HTMLInputElement | undefined
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

  /**
   * 🔴 Exposed only now that a transport exists. The plan held rotation back on purpose: "a successor
   * statement no peer can receive would strand the user", and until instances could talk there was
   * nobody to receive it — so issuing one would have quietly orphaned the user from everyone who
   * knew them, with nothing on screen to say so.
   */
  const rotate = async () => {
    const current = connection()
    if (!current) return
    setBusy(true)
    try {
      const result = await communityRotate(current.http)
      setRotated(language.t("settings.identity.rotateDone").replace("{count}", String(result.told)))
      setRotating(false)
      await identityActions.refetch()
    } finally {
      setBusy(false)
    }
  }

  const chooseFile = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    // Cleared straight away so choosing the SAME file twice still fires a change event.
    input.value = ""
    if (!file) return
    setRestoreNote("")
    void file.text().then((text) => {
      const parsed = readBackup(text)
      if (!parsed) {
        setRestoreNote(language.t("settings.identity.restoreUnreadable"))
        return
      }
      setPending(parsed)
    })
  }

  /**
   * 🔴 `replace` is always true here, and that is honest rather than lazy: this instance always has
   * an identity by the time Settings can be opened, so a restore that did not replace could only
   * ever fail. The safety is not in withholding the flag — it is in the confirm above naming what
   * is lost, which is the only place a person can still stop.
   */
  const restore = async () => {
    const current = connection()
    const bundle = pending()
    if (!current || !bundle) return
    setBusy(true)
    try {
      const result = await instanceIdentityRestore(current.http, bundle, { replace: true })
      setRestoreNote(language.t("settings.identity.restoreDone").replace("{id}", result.networkID))
      setPending(undefined)
      await identityActions.refetch()
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
          description={
            <>
              {language.t("settings.identity.networkIDDescription")}
              <SettingsExplainV2 label={language.t("settings.identity.networkID")}>
                {language.t("settings.identity.networkIDHint")}
              </SettingsExplainV2>
            </>
          }
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
          description={
            <>
              {language.t("settings.identity.backupDescription")}
              <SettingsExplainV2 label={language.t("settings.identity.backupTitle")}>
                {language.t("settings.identity.backupHint")}
              </SettingsExplainV2>
            </>
          }
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
        {/*
          🔴 Backup's other half. It shipped alone — a user could export an identity and had nowhere
          to put it back, so the button led nowhere and the spec's "key loss = identity loss, and
          with no authority there is no reset" had no answer in the product.

          ⚠️ The confirm names the identity being restored AND says what replacing costs, because
          this is the one control here that cannot be undone by pressing it again: the contacts and
          channels attached to the CURRENT key stop being able to find this instance.

          🔴 It also says what happens to what this instance ALREADY SAID, which the first version
          missed by warning only about other people. Measured on a running pair: a fresh install
          posted three messages, restored a backup minted elsewhere, and all three were left authored
          by a key it no longer holds — the user's own words, indistinguishable from a stranger's.
          Nothing is deleted and nothing is wrong: they really were signed by the replaced key, and
          re-attributing them would be forging history. But the panel does not mark own messages, so
          NOTHING on screen would ever tell them — which makes saying it beforehand the only chance.
        */}
        <SettingsRowV2
          title={language.t("settings.identity.restoreTitle")}
          description={
            <>
              {language.t("settings.identity.restoreDescription")}
              <SettingsExplainV2 label={language.t("settings.identity.restoreTitle")}>
                {language.t("settings.identity.restoreHint")}
              </SettingsExplainV2>
            </>
          }
        >
          <input
            ref={(element) => (fileInput = element)}
            type="file"
            accept="application/json,.json"
            class="hidden"
            onChange={chooseFile}
          />
          <Show
            when={pending()}
            fallback={
              <div class="flex items-center gap-2">
                <ButtonV2 variant="neutral" size="small" disabled={busy()} onClick={() => fileInput?.click()}>
                  {language.t("settings.identity.restoreAction")}
                </ButtonV2>
                <Show when={restoreNote()}>
                  <span class="text-[11px] text-v2-text-text-muted">{restoreNote()}</span>
                </Show>
              </div>
            }
          >
            {(bundle) => (
              <div class="flex flex-col items-end gap-1">
                <span class="text-[11px] text-v2-text-text-muted">{language.t("settings.identity.restoreChosen")}</span>
                {/* Selectable and monospaced like the id above it: the user is being asked to
                    confirm a key, so they have to be able to READ the key. */}
                <span class="select-text truncate font-mono text-[11px] text-v2-text-text-muted">
                  {bundle().networkID}
                </span>
                <div class="flex items-center gap-2">
                  <ButtonV2 variant="neutral" size="small" disabled={busy()} onClick={() => void restore()}>
                    {busy()
                      ? language.t("settings.identity.restoreBusy")
                      : language.t("settings.identity.restoreProceed")}
                  </ButtonV2>
                  <ButtonV2 variant="ghost" size="small" disabled={busy()} onClick={() => setPending(undefined)}>
                    {language.t("settings.identity.restoreCancel")}
                  </ButtonV2>
                </div>
              </div>
            )}
          </Show>
        </SettingsRowV2>
        <SettingsRowV2
          title={language.t("settings.identity.rotateTitle")}
          description={
            <>
              {language.t("settings.identity.rotateDescription")}
              <SettingsExplainV2 label={language.t("settings.identity.rotateTitle")}>
                {language.t("settings.identity.rotateHint")}
              </SettingsExplainV2>
            </>
          }
        >
          <Show
            when={rotating()}
            fallback={
              <div class="flex items-center gap-2">
                <ButtonV2 variant="neutral" size="small" onClick={() => setRotating(true)}>
                  {language.t("settings.identity.rotateAction")}
                </ButtonV2>
                <Show when={rotated()}>
                  <span class="text-[11px] text-v2-text-text-muted">{rotated()}</span>
                </Show>
              </div>
            }
          >
            {/* A second, explicit press — like the backup beside it, and for a heavier reason: this
                one cannot be undone by pressing it again, and the confirm is where that is said. */}
            <div class="flex items-center gap-2">
              <span class="text-[11px] text-v2-text-text-muted">{language.t("settings.identity.rotateConfirm")}</span>
              <ButtonV2 variant="neutral" size="small" disabled={busy()} onClick={() => void rotate()}>
                {busy() ? language.t("settings.identity.rotateBusy") : language.t("settings.identity.rotateProceed")}
              </ButtonV2>
              <ButtonV2 variant="ghost" size="small" disabled={busy()} onClick={() => setRotating(false)}>
                {language.t("settings.identity.rotateCancel")}
              </ButtonV2>
            </div>
          </Show>
        </SettingsRowV2>
      </SettingsListV2>
    </section>
  )
}
