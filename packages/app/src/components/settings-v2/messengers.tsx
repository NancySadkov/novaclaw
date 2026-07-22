import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@novaclaw/ui/v2/dialog-v2"
import { DividerV2 } from "@novaclaw/ui/v2/divider-v2"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { type Component, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useConfirm } from "@/components/dialog-confirm"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import {
  MessengerApiError,
  messengerAccounts,
  messengerCreateAccount,
  messengerDrivers,
  messengerLoginBegin,
  messengerLoginCancel,
  messengerLoginComplete,
  messengerMintPairing,
  messengerRemoveAccount,
  messengerUpdateAccount,
  type AccountStatus,
  type AccountWithStatus,
  type DriverMeta,
  type LoginAttempt,
} from "@/utils/messenger-api"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

// Settings → Messengers (notes/messenger-plan.md §6.1) — "which messenger apps can NovaClaw use?"
// A headline lay feature (Normal level): connect NovaClaw to Telegram & friends so the agent can
// cover chats while you're away, and pair your phone for remote control. Accounts are
// instance-global (they live on the server, not this window); status streams live over SSE
// (messenger.account.status → refetch — the list is small, a refetch is simpler and always
// truthful). The Add flow branches on the driver's auth kind (§0.2): `login` = sign into YOUR OWN
// account (phone → code → optional 2FA, the lay default), `key` = paste a bot/app token (opt-in
// power path), `none` = just settings. Secrets go up the wire once and never come back.

const STATUS_DOT: Record<AccountStatus["state"], string> = {
  connected: "bg-v2-state-fg-success",
  connecting: "bg-v2-state-fg-warning",
  backoff: "bg-v2-state-fg-warning",
  challenge: "bg-v2-state-fg-danger",
  error: "bg-v2-state-fg-danger",
  disabled: "bg-v2-icon-icon-muted",
  airgapped: "bg-v2-icon-icon-muted",
}

const statusMessage = (status: AccountStatus): string | undefined =>
  status.state === "backoff" || status.state === "challenge" || status.state === "error" ? status.message : undefined

export const SettingsMessengersV2: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useServerSDK()
  const serverSync = useServerSync()
  const confirm = useConfirm()

  const server = () => sdk().server.http
  const airgapped = () =>
    (serverSync().data.config as { offline?: { enabled?: boolean } }).offline?.enabled === true

  const [drivers] = createResource(() => server(), messengerDrivers, { initialValue: [] })
  const [accounts, { refetch }] = createResource(() => server(), messengerAccounts, { initialValue: [] })

  // Live status: any messenger.* bus event → refetch the small list (always truthful, no client fold).
  onMount(() => {
    const unsub = sdk().event.listen((e) => {
      if ((e.details.type as string).startsWith("messenger.")) void refetch()
    })
    onCleanup(unsub)
  })

  const fail = (error: unknown) =>
    showToast({
      variant: "error",
      title: language.t("settings.messengers.toast.failed"),
      description: error instanceof Error ? error.message : String(error),
    })

  const driverFor = (driverID: string): DriverMeta | undefined => drivers.latest.find((d) => d.id === driverID)
  const driverName = (driverID: string): string => driverFor(driverID)?.name ?? driverID

  const setEnabled = (row: AccountWithStatus, enabled: boolean) =>
    messengerUpdateAccount(server(), row.account.id, { enabled }).then(refetch).catch(fail)

  const remove = async (row: AccountWithStatus) => {
    const ok = await confirm({
      title: language.t("settings.messengers.remove.confirm.title", { label: row.account.label }),
      description: language.t("settings.messengers.remove.confirm.description"),
      confirmLabel: language.t("settings.messengers.remove.confirm.action"),
      destructive: true,
    })
    if (!ok) return
    await messengerRemoveAccount(server(), row.account.id).then(refetch).catch(fail)
  }

  const openAdd = () =>
    dialog.push(() => (
      <DialogAddMessengerAccount
        drivers={drivers.latest}
        onCreated={(account, driver) => {
          void refetch()
          if (driver.auth === "login") dialog.push(() => <DialogMessengerLogin account={account} driver={driver} onDone={() => void refetch()} />)
        }}
      />
    ))

  const openLogin = (row: AccountWithStatus) => {
    const driver = driverFor(row.account.driverID)
    if (!driver) return
    dialog.push(() => <DialogMessengerLogin account={row.account} driver={driver} onDone={() => void refetch()} />)
  }

  const openPair = (row: AccountWithStatus) => {
    dialog.push(() => <DialogPairingCode accountID={row.account.id} label={row.account.label} />)
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">{language.t("settings.messengers.title")}</h2>
          <ButtonV2 variant="contrast" onClick={openAdd} disabled={drivers.latest.length === 0}>
            {language.t("settings.messengers.add")}
          </ButtonV2>
        </div>
        <p class="settings-v2-tab-description">{language.t("settings.messengers.description")}</p>
      </div>

      <div class="settings-v2-tab-body">
        <Show when={airgapped()}>
          <p class="settings-v2-field-description">{language.t("settings.messengers.airgapped")}</p>
        </Show>

        <Show
          when={accounts.latest.length > 0}
          fallback={<p class="settings-v2-field-description">{language.t("settings.messengers.empty")}</p>}
        >
          <SettingsListV2>
            <For each={accounts.latest}>
              {(row) => (
                <SettingsRowV2
                  title={row.account.label}
                  description={
                    driverName(row.account.driverID) +
                    " · " +
                    language.t(`settings.messengers.status.${row.status.state}`) +
                    (statusMessage(row.status) ? ` — ${statusMessage(row.status)}` : "")
                  }
                >
                  <div class="flex items-center gap-3">
                    <span
                      class={`shrink-0 size-1.5 rounded-full ${STATUS_DOT[row.status.state]}`}
                      aria-label={language.t(`settings.messengers.status.${row.status.state}`)}
                    />
                    <Show when={driverFor(row.account.driverID)?.auth === "login"}>
                      <ButtonV2 variant="neutral" size="small" onClick={() => openLogin(row)}>
                        {language.t("settings.messengers.login")}
                      </ButtonV2>
                    </Show>
                    <ButtonV2 variant="neutral" size="small" onClick={() => openPair(row)}>
                      {language.t("settings.messengers.pair")}
                    </ButtonV2>
                    <ButtonV2 variant="neutral" size="small" onClick={() => void remove(row)}>
                      {language.t("settings.messengers.remove.confirm.action")}
                    </ButtonV2>
                    <Switch checked={row.account.enabled} onChange={(checked) => void setEnabled(row, checked)} hideLabel>
                      {language.t("settings.messengers.enabled")}
                    </Switch>
                  </div>
                </SettingsRowV2>
              )}
            </For>
          </SettingsListV2>
        </Show>
      </div>
    </>
  )
}

// ── Add account: pick a messenger, fill its fields ────────────────────────────────────────────────

const DialogAddMessengerAccount: Component<{
  drivers: readonly DriverMeta[]
  onCreated: (account: { id: string; driverID: string; label: string; enabled: boolean; settings: Record<string, string> }, driver: DriverMeta) => void
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useServerSDK()
  const [driver, setDriver] = createSignal<DriverMeta | undefined>(props.drivers.length === 1 ? props.drivers[0] : undefined)
  const [label, setLabel] = createSignal("")
  const [secret, setSecret] = createSignal("")
  const [fields, setFields] = createSignal<Record<string, string>>({})
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const submit = async () => {
    const chosen = driver()
    if (!chosen) return
    setBusy(true)
    setError(undefined)
    try {
      const account = await messengerCreateAccount(sdk().server.http, {
        driverID: chosen.id,
        label: label().trim() || chosen.name,
        // login accounts start disabled — there is no session credential to connect with yet;
        // finishing the login wizard is what makes enabling meaningful.
        enabled: chosen.auth !== "login",
        settings: fields(),
        ...(chosen.auth === "key" && secret().trim() ? { secret: secret().trim() } : {}),
      })
      dialog.close()
      props.onCreated(account, chosen)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog fit class="settings-v2-server-dialog">
      <DialogHeader hideClose={true}>
        <DialogTitle>{language.t("settings.messengers.add")}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col px-4 pt-4 pb-2">
        <div class="flex w-full min-w-0 flex-col gap-4">
          <Show
            when={driver()}
            fallback={
              <div class="flex w-full flex-col gap-2">
                <label class="settings-v2-server-dialog-label">{language.t("settings.messengers.pickDriver")}</label>
                <For each={props.drivers}>
                  {(item) => (
                    <ButtonV2 variant="neutral" onClick={() => setDriver(item)}>
                      {item.name}
                    </ButtonV2>
                  )}
                </For>
              </div>
            }
          >
            {(chosen) => (
              <>
                <p class="settings-v2-field-description">
                  {language.t(`settings.messengers.auth.${chosen().auth}`)}
                </p>
                <div class="flex w-full min-w-0 flex-col gap-2">
                  <label class="settings-v2-server-dialog-label">{language.t("settings.messengers.label")}</label>
                  <TextInputV2
                    type="text"
                    appearance="large"
                    class="!w-full self-stretch"
                    value={label()}
                    placeholder={chosen().name}
                    disabled={busy()}
                    onInput={(event) => setLabel(event.currentTarget.value)}
                  />
                </div>
                <For each={chosen().settings}>
                  {(prompt) => (
                    <div class="flex w-full min-w-0 flex-col gap-2">
                      <label class="settings-v2-server-dialog-label">{prompt.message}</label>
                      <TextInputV2
                        type="text"
                        appearance="large"
                        class="!w-full self-stretch"
                        value={fields()[prompt.key] ?? ""}
                        placeholder={prompt.placeholder ?? ""}
                        disabled={busy()}
                        spellcheck={false}
                        autocomplete="off"
                        onInput={(event) => setFields({ ...fields(), [prompt.key]: event.currentTarget.value })}
                      />
                    </div>
                  )}
                </For>
                <Show when={chosen().auth === "key"}>
                  <div class="flex w-full min-w-0 flex-col gap-2">
                    <label class="settings-v2-server-dialog-label">{language.t("settings.messengers.secret")}</label>
                    <TextInputV2
                      type="password"
                      appearance="large"
                      class="!w-full self-stretch"
                      value={secret()}
                      disabled={busy()}
                      onInput={(event) => setSecret(event.currentTarget.value)}
                    />
                  </div>
                </Show>
                <Show when={error()}>
                  <span class="settings-v2-server-dialog-error">{error()}</span>
                </Show>
              </>
            )}
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" disabled={busy()} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={busy() || !driver()} onClick={() => void submit()}>
          {driver()?.auth === "login" ? language.t("settings.messengers.addThenLogin") : language.t("common.save")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}

// ── Login wizard: phone (+ optional 2FA password) → the code the provider sent ────────────────────

const DialogMessengerLogin: Component<{
  account: { id: string; label: string }
  driver: DriverMeta
  onDone: () => void
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useServerSDK()
  const [inputs, setInputs] = createSignal<Record<string, string>>({})
  const [attempt, setAttempt] = createSignal<LoginAttempt>()
  const [code, setCode] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const begin = async () => {
    setBusy(true)
    setError(undefined)
    try {
      setAttempt(await messengerLoginBegin(sdk().server.http, props.account.id, inputs()))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const complete = async () => {
    const pending = attempt()
    if (!pending) return
    setBusy(true)
    setError(undefined)
    try {
      await messengerLoginComplete(sdk().server.http, pending.attemptID, code())
      // The server stored the session credential and reconnected the account.
      await messengerUpdateAccount(sdk().server.http, props.account.id, { enabled: true }).catch(() => undefined)
      showToast({ variant: "success", title: language.t("settings.messengers.login.done") })
      dialog.close()
      props.onDone()
    } catch (cause) {
      if (cause instanceof MessengerApiError && cause.retryableLogin) {
        // A mistyped code — the attempt is still alive, just re-ask.
        setError(cause.message)
        setCode("")
      } else {
        // Terminal: back to the inputs step so the user can restart cleanly.
        setError(cause instanceof Error ? cause.message : String(cause))
        setAttempt(undefined)
        setCode("")
      }
    } finally {
      setBusy(false)
    }
  }

  const cancel = () => {
    const pending = attempt()
    if (pending) void messengerLoginCancel(sdk().server.http, pending.attemptID).catch(() => undefined)
    dialog.close()
  }

  return (
    <Dialog fit class="settings-v2-server-dialog">
      <DialogHeader hideClose={true}>
        <DialogTitle>{language.t("settings.messengers.login.title", { label: props.account.label })}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col px-4 pt-4 pb-2">
        <div class="flex w-full min-w-0 flex-col gap-4">
          <Show
            when={attempt()}
            fallback={
              <>
                <For each={props.driver.loginPrompts ?? []}>
                  {(prompt) => (
                    <div class="flex w-full min-w-0 flex-col gap-2">
                      <label class="settings-v2-server-dialog-label">{prompt.message}</label>
                      <TextInputV2
                        type={prompt.key === "password" ? "password" : "text"}
                        appearance="large"
                        class="!w-full self-stretch"
                        value={inputs()[prompt.key] ?? ""}
                        placeholder={prompt.placeholder ?? ""}
                        disabled={busy()}
                        spellcheck={false}
                        autocomplete="off"
                        onInput={(event) => setInputs({ ...inputs(), [prompt.key]: event.currentTarget.value })}
                      />
                    </div>
                  )}
                </For>
              </>
            }
          >
            {(pending) => (
              <div class="flex w-full min-w-0 flex-col gap-2">
                <p class="settings-v2-field-description">{pending().instructions}</p>
                <TextInputV2
                  type="text"
                  appearance="large"
                  class="!w-full self-stretch"
                  value={code()}
                  placeholder={language.t("settings.messengers.login.codePlaceholder")}
                  disabled={busy()}
                  spellcheck={false}
                  autocomplete="one-time-code"
                  onInput={(event) => setCode(event.currentTarget.value)}
                  onKeyDown={(event: KeyboardEvent) => {
                    if (event.key === "Enter" && !event.isComposing) void complete()
                  }}
                />
              </div>
            )}
          </Show>
          <Show when={error()}>
            <span class="settings-v2-server-dialog-error">{error()}</span>
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" disabled={busy()} onClick={cancel}>
          {language.t("common.cancel")}
        </ButtonV2>
        <Show
          when={attempt()}
          fallback={
            <ButtonV2 variant="contrast" disabled={busy()} onClick={() => void begin()}>
              {busy() ? language.t("settings.messengers.login.sending") : language.t("settings.messengers.login.sendCode")}
            </ButtonV2>
          }
        >
          <ButtonV2 variant="contrast" disabled={busy() || code().trim().length === 0} onClick={() => void complete()}>
            {busy() ? language.t("settings.messengers.login.checking") : language.t("settings.messengers.login.finish")}
          </ButtonV2>
        </Show>
      </DialogFooter>
    </Dialog>
  )
}

// ── Pairing: mint a one-time code the phone redeems with /pair <code> ─────────────────────────────

const DialogPairingCode: Component<{ accountID: string; label: string }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useServerSDK()
  const [pairing] = createResource(
    () => sdk().server.http,
    (server) => messengerMintPairing(server, props.accountID, "operator"),
  )

  return (
    <Dialog fit class="settings-v2-server-dialog">
      <DialogHeader hideClose={true}>
        <DialogTitle>{language.t("settings.messengers.pair.title", { label: props.label })}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col px-4 pt-4 pb-2">
        <div class="flex w-full min-w-0 flex-col gap-3">
          <Show
            when={pairing()}
            fallback={
              <Show when={pairing.error} fallback={<p class="settings-v2-field-description">…</p>}>
                <span class="settings-v2-server-dialog-error">{String(pairing.error)}</span>
              </Show>
            }
          >
            {(minted) => (
              <>
                <p class="settings-v2-field-description">{language.t("settings.messengers.pair.instructions")}</p>
                <p class="settings-v2-tab-title" data-testid="pairing-code">
                  /pair {minted().code}
                </p>
                <p class="settings-v2-field-description">{language.t("settings.messengers.pair.expiry")}</p>
              </>
            )}
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="contrast" onClick={() => dialog.close()}>
          {language.t("common.close")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
