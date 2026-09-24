import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@novaclaw/ui/v2/dialog-v2"
import { DividerV2 } from "@novaclaw/ui/v2/divider-v2"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { type Component, createEffect, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useConfirm } from "@/components/dialog-confirm"
import { Link } from "@/components/link"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { createSettledResource } from "@/utils/settled-resource"
import {
  MessengerApiError,
  messengerAccounts,
  messengerAccountChats,
  messengerCreateAccount,
  messengerDeclareChatSource,
  messengerDrivers,
  messengerLoginBegin,
  messengerLoginCancel,
  messengerLoginComplete,
  messengerLoginStatus,
  messengerMintPairing,
  messengerRemoveAccount,
  messengerUpdateAccount,
  type AccountStatus,
  type AccountWithStatus,
  type ChatInfo,
  type DriverMeta,
  type LoginAttempt,
} from "@/utils/messenger-api"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { parseSettingsNumber } from "./parts/number-field"

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

export const OfficerMessengers: Component<{ agentID: string }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useServerSDK()
  const serverSync = useServerSync()
  const confirm = useConfirm()

  const server = () => sdk().server.http
  // `Config.offline` is a plain boolean (config.ts), not `{ enabled }` — the nested read was
  // always undefined, so no account could ever render as airgapped here even while the gateway
  // parked it. Same form as general.tsx's OFF-C indicator.
  const airgapped = () => (serverSync().data.config as { offline?: boolean }).offline === true

  const [drivers] = createSettledResource(() => server(), messengerDrivers)
  const [accounts, { refetch }] = createSettledResource(
    () => [server(), props.agentID] as const,
    ([http, agentID]) => messengerAccounts(http, agentID),
  )
  const ownedAccounts = () => (accounts() ?? []).filter((row) => row.account.agentID === props.agentID)

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

  const driverFor = (driverID: string): DriverMeta | undefined => (drivers() ?? []).find((d) => d.id === driverID)
  const driverName = (driverID: string): string => driverFor(driverID)?.name ?? driverID

  const setEnabled = (row: AccountWithStatus, enabled: boolean) =>
    messengerUpdateAccount(server(), row.account.id, props.agentID, { enabled }).then(refetch).catch(fail)

  const remove = async (row: AccountWithStatus) => {
    const ok = await confirm({
      title: language.t("settings.messengers.remove.confirm.title", { label: row.account.label }),
      description: language.t("settings.messengers.remove.confirm.description"),
      confirmLabel: language.t("settings.messengers.remove.confirm.action"),
      destructive: true,
    })
    if (!ok) return
    await messengerRemoveAccount(server(), row.account.id, props.agentID).then(refetch).catch(fail)
  }

  const openAdd = () =>
    dialog.showScoped(() => (
      <DialogAddMessengerAccount
        agentID={props.agentID}
        drivers={drivers() ?? []}
        onCreated={(account, driver) => {
          void refetch()
          if (driver.auth === "login")
            dialog.showScoped(() => <DialogMessengerLogin account={account} driver={driver} onDone={() => void refetch()} />)
        }}
      />
    ))

  const openLogin = (row: AccountWithStatus) => {
    const driver = driverFor(row.account.driverID)
    if (!driver) return
    dialog.showScoped(() => <DialogMessengerLogin account={row.account} driver={driver} onDone={() => void refetch()} />)
  }

  const openPair = (row: AccountWithStatus) => {
    dialog.showScoped(() => <DialogPairingCode accountID={row.account.id} label={row.account.label} />)
  }

  const openSpeed = (row: AccountWithStatus) => {
    dialog.showScoped(() => <DialogMessengerSpeed account={row.account} onDone={() => void refetch()} />)
  }

  const openChats = (row: AccountWithStatus) => {
    dialog.showScoped(() => <DialogMessengerSources account={row.account} agentID={props.agentID} />)
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">{language.t("settings.messengers.title")}</h2>
          <ButtonV2 variant="contrast" onClick={openAdd} disabled={!drivers()?.length}>
            {language.t("settings.messengers.add")}
          </ButtonV2>
        </div>
      </div>

      <div class="settings-v2-tab-body">
        <Show when={airgapped()}>
          <p class="settings-v2-field-description">{language.t("settings.messengers.airgapped")}</p>
        </Show>

        <Show
          when={!accounts.failed && ownedAccounts().length > 0}
          fallback={
            <p class="settings-v2-field-description">
              {accounts.failed
                ? language.t("settings.messengers.toast.failed")
                : accounts.loading || accounts.idle
                  ? language.t("common.loading")
                  : language.t("settings.messengers.empty")}
            </p>
          }
        >
          <SettingsListV2>
            <For each={ownedAccounts()}>
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
                  <div class="flex flex-wrap items-center justify-end gap-2">
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
                    <ButtonV2 variant="neutral" size="small" onClick={() => openSpeed(row)}>
                      {language.t("settings.messengers.speed")}
                    </ButtonV2>
                    <ButtonV2 variant="neutral" size="small" onClick={() => openChats(row)}>
                      {language.t("settings.messengers.chats")}
                    </ButtonV2>
                    <ButtonV2 variant="neutral" size="small" onClick={() => void remove(row)}>
                      {language.t("settings.messengers.remove.confirm.action")}
                    </ButtonV2>
                    <Switch
                      checked={row.account.enabled}
                      onChange={(checked) => void setEnabled(row, checked)}
                      hideLabel
                    >
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

const DialogMessengerSources: Component<{
  account: { id: string; label: string }
  agentID: string
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useServerSDK()
  const [chats, { refetch }] = createSettledResource(
    () => [sdk().server.http, props.account.id] as const,
    ([server, accountID]) => messengerAccountChats(server, accountID),
  )
  const [saving, setSaving] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const options = () => [
    { id: "none", label: language.t("settings.messengers.sources.none") },
    { id: "public", label: language.t("settings.messengers.sources.public") },
    { id: "private", label: language.t("settings.messengers.sources.private") },
  ] as const

  const setAccess = async (chat: ChatInfo, choice: "none" | "public" | "private") => {
    const previous = chat.access.declared ?? "none"
    if (choice === previous || saving()) return
    setSaving(chat.chatID)
    setError(undefined)
    try {
      await messengerDeclareChatSource(
        sdk().server.http,
        props.agentID,
        props.account.id,
        chat.chatID,
        choice === "none" ? null : choice,
      )
      await refetch()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(undefined)
    }
  }

  return (
    <Dialog fit class="settings-v2-server-dialog">
      <DialogHeader hideClose={true}>
        <DialogTitle>{language.t("settings.messengers.sources.title", { label: props.account.label })}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 max-h-[min(72vh,600px)] flex-1 flex-col overflow-y-auto px-4 pt-4 pb-2">
        <p class="settings-v2-field-description">{language.t("settings.messengers.sources.hint")}</p>
        <Show when={error()}>{(message) => <p class="settings-v2-server-dialog-error">{message()}</p>}</Show>
        <Show
          when={!chats.failed && chats()?.ok && chats()?.chats.length}
          fallback={
            <div class="flex items-center justify-between gap-3">
              <p class="settings-v2-field-description">
                {chats.failed
                  ? language.t("settings.messengers.sources.unavailable")
                  : chats.loading || chats.idle
                    ? language.t("common.loading")
                    : chats()?.reason ?? language.t("settings.messengers.sources.empty")}
              </p>
              <Show when={!chats.loading && !chats.idle}>
                <ButtonV2 variant="neutral" size="small" onClick={() => void refetch()}>
                  {language.t("settings.messengers.sources.retry")}
                </ButtonV2>
              </Show>
            </div>
          }
        >
          <SettingsListV2>
            <For each={chats()?.chats ?? []}>
              {(chat) => (
                <SettingsRowV2 title={chat.title || chat.chatID} description={chat.kind}>
                  <SelectV2
                    appearance="inline"
                    data-action="messenger-source-access"
                    aria-label={language.t("settings.messengers.sources.control", { label: chat.title || chat.chatID })}
                    options={options()}
                    current={options().find((option) => option.id === chat.access.declared) ?? options()[0]}
                    placement="bottom-end"
                    gutter={6}
                    disabled={!!saving()}
                    value={(option) => option.id}
                    label={(option) => option.label}
                    onSelect={(option) => {
                      if (option) void setAccess(chat, option.id)
                    }}
                  />
                </SettingsRowV2>
              )}
            </For>
          </SettingsListV2>
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="contrast" onClick={() => dialog.close()}>
          {language.t("common.close")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}

// ── Add account: pick a messenger, fill its fields ────────────────────────────────────────────────

const DialogAddMessengerAccount: Component<{
  agentID: string
  drivers: readonly DriverMeta[]
  onCreated: (
    account: {
      id: string
      agentID: string
      driverID: string
      label: string
      enabled: boolean
      settings: Record<string, string>
    },
    driver: DriverMeta,
  ) => void
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useServerSDK()
  const [driver, setDriver] = createSignal<DriverMeta | undefined>(
    props.drivers.length === 1 ? props.drivers[0] : undefined,
  )
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
        agentID: props.agentID,
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
                <p class="settings-v2-field-description">{language.t(`settings.messengers.auth.${chosen().auth}`)}</p>
                {/* The credential recipe, right where the empty field is. A Discord bot takes a
                    trip through a developer portal with switches that fail silently when missed —
                    nobody should need a blog post to set up a support desk. */}
                <Show when={chosen().setup}>
                  {(setup) => (
                    <div class="flex w-full min-w-0 flex-col gap-2 rounded-md bg-v2-background-bg-layer-02 p-3">
                      <span class="settings-v2-server-dialog-label">
                        {language.t("settings.messengers.setup.title")}
                      </span>
                      <ol class="settings-v2-field-description flex list-decimal flex-col gap-1 pl-4">
                        <For each={setup().steps}>{(step) => <li>{step}</li>}</For>
                      </ol>
                      <Show when={setup().url}>
                        {(url) => (
                          <Link class="settings-v2-link" href={url()}>
                            {setup().urlLabel ?? language.t("settings.messengers.setup.open")}
                          </Link>
                        )}
                      </Show>
                    </div>
                  )}
                </Show>
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
  account: { id: string; agentID: string; label: string }
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
  // The step's LIVE presentation. Some providers rotate what the user must act on while they act on
  // it — WhatsApp mints a fresh linked-device QR every ~20s and an expired one simply will not scan,
  // with no feedback on the phone. So what `begin` returned is only the first frame; the poll below
  // keeps this current and the dialog renders from here.
  const [live, setLive] = createSignal<{ instructions: string; qrImage?: string }>()
  const instructions = () => live()?.instructions ?? attempt()?.instructions ?? ""
  const qrImage = () => live()?.qrImage ?? attempt()?.qrImage

  const begin = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const started = await messengerLoginBegin(sdk().server.http, props.account.id, inputs())
      setAttempt(started)
      setLive({ instructions: started.instructions, ...(started.qrImage ? { qrImage: started.qrImage } : {}) })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  // "browser" login (Gmail's Sign in with Google): NovaClaw opens the browser and the loopback
  // catches the redirect server-side, so there is no code to type — the wizard just polls complete()
  // until it resolves. "code" logins (Telegram SMS, Outlook device-code) keep the typed-code step.
  const isBrowser = () => props.driver.loginStyle === "browser"

  // One completion path. `silent` (the browser auto-poll) suppresses the busy spinner and the
  // "still waiting" error so a normal wait doesn't flash red on every poll.
  const submit = async (options?: { silent?: boolean }) => {
    const pending = attempt()
    if (!pending) return
    const silent = options?.silent ?? false
    if (!silent) {
      setBusy(true)
      setError(undefined)
    }
    try {
      await messengerLoginComplete(sdk().server.http, pending.attemptID, code())
      // The server stored the session credential and reconnected the account.
      await messengerUpdateAccount(sdk().server.http, props.account.id, props.account.agentID, { enabled: true }).catch(
        () => undefined,
      )
      showToast({ variant: "success", title: language.t("settings.messengers.login.done") })
      dialog.close()
      props.onDone()
    } catch (cause) {
      if (cause instanceof MessengerApiError && cause.retryableLogin) {
        // Still pending: a mistyped code (code flow) or the browser sign-in not finished yet (browser
        // flow, the normal case). Re-ask; stay quiet while auto-polling.
        if (!silent) {
          setError(cause.message)
          setCode("")
        }
      } else {
        // Terminal: back to the inputs step so the user can restart cleanly.
        setError(cause instanceof Error ? cause.message : String(cause))
        setAttempt(undefined)
        setLive(undefined)
        setCode("")
      }
    } finally {
      if (!silent) setBusy(false)
    }
  }

  const complete = () => submit()

  // Browser flow: once the attempt exists, poll completion until it resolves or terminally fails. A
  // one-in-flight latch avoids overlapping completes (the server rejects concurrent ones). The same
  // tick refreshes the step's presentation first, so a rotating QR on screen is never the expired
  // one. A status failure is not fatal — keep polling completion regardless.
  let polling = false
  const pollOnce = async () => {
    if (polling) return
    polling = true
    try {
      const pending = attempt()
      if (pending) {
        const status = await messengerLoginStatus(sdk().server.http, pending.attemptID).catch(() => undefined)
        if (status?.status === "pending" && status.instructions)
          setLive({ instructions: status.instructions, ...(status.qrImage ? { qrImage: status.qrImage } : {}) })
      }
      await submit({ silent: true })
    } finally {
      polling = false
    }
  }
  createEffect(() => {
    const pending = attempt()
    if (!pending || !isBrowser()) return
    void pollOnce()
    const timer = setInterval(() => void pollOnce(), 2500)
    onCleanup(() => clearInterval(timer))
  })

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
            {(_pending) => (
              <div class="flex w-full min-w-0 flex-col gap-2">
                <p class="settings-v2-field-description" style={{ "white-space": "pre-line" }}>
                  {instructions()}
                </p>
                {/* A scanned step (WhatsApp's linked-device QR). The PNG carries its own white
                    quiet-zone, so it stays scannable in either theme without a themed wrapper. */}
                <Show when={qrImage()}>
                  {(image) => (
                    <div class="flex w-full justify-center py-1">
                      <img
                        src={image()}
                        alt="QR code to scan in WhatsApp → Linked Devices"
                        width={320}
                        height={320}
                        class="h-auto w-full max-w-[280px] rounded-md"
                      />
                    </div>
                  )}
                </Show>
                <Show
                  when={!isBrowser()}
                  fallback={
                    // Browser flow: nothing to type — we poll while the sign-in finishes. (en-only; rides
                    // the next localization pass, like the driver-supplied instructions above.)
                    <p class="settings-v2-field-description">
                      {qrImage()
                        ? "Waiting for you to scan the code with your phone…"
                        : "Waiting for you to finish signing in in your browser…"}
                    </p>
                  }
                >
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
                </Show>
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
              {busy()
                ? language.t("settings.messengers.login.sending")
                : language.t("settings.messengers.login.sendCode")}
            </ButtonV2>
          }
        >
          <Show
            when={!isBrowser()}
            fallback={
              // Browser flow: no Finish button — completion is automatic once the browser sign-in lands.
              <ButtonV2 variant="contrast" disabled={true}>
                {language.t("settings.messengers.login.checking")}
              </ButtonV2>
            }
          >
            <ButtonV2
              variant="contrast"
              disabled={busy() || code().trim().length === 0}
              onClick={() => void complete()}
            >
              {busy()
                ? language.t("settings.messengers.login.checking")
                : language.t("settings.messengers.login.finish")}
            </ButtonV2>
          </Show>
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

// ── Typing speed / throttling (traffic rules §2.3) ─────────────────────────────────────────────────
// Per-account outbound typing speed. NovaClaw paces its messages at human typing speed so a real
// person's account is never flagged as a bot; the user MAY speed it up, but going too fast is the
// single biggest ban risk, so we warn above the "risky" mark. The value writes into the account's
// settings (paceCharsPerSecond); the gateway's pacer honours it (core/messenger/pace.ts). Constants
// mirror core PACE_CPS_* — kept local so this browser panel never imports the server pace module.
const PACE_KEY = "paceCharsPerSecond"
const PACE_DEFAULT = 15
const PACE_MIN = 3
const PACE_MAX = 80
const PACE_RISKY = 30

const DialogMessengerSpeed: Component<{
  account: { id: string; agentID: string; label: string; settings: Record<string, string> }
  onDone: () => void
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useServerSDK()
  const initial = Number(props.account.settings[PACE_KEY] ?? "")
  const [cps, setCps] = createSignal(
    Number.isFinite(initial) && initial > 0 ? String(Math.round(initial)) : String(PACE_DEFAULT),
  )
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const value = () => parseSettingsNumber(cps(), { min: PACE_MIN, max: PACE_MAX })
  const risky = () => (value() ?? 0) > PACE_RISKY

  const save = async () => {
    const next = value()
    if (next === undefined) {
      setError(language.t("settings.field.number.range", { min: PACE_MIN, max: PACE_MAX }))
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      await messengerUpdateAccount(sdk().server.http, props.account.id, props.account.agentID, {
        settings: { ...props.account.settings, [PACE_KEY]: String(next) },
      })
      props.onDone()
      dialog.close()
    } catch (err) {
      setError(err instanceof MessengerApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog fit class="settings-v2-server-dialog">
      <DialogHeader hideClose={true}>
        <DialogTitle>{language.t("settings.messengers.speed.title", { label: props.account.label })}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col px-4 pt-4 pb-2">
        <div class="flex w-full min-w-0 flex-col gap-3">
          <p class="settings-v2-field-description">{language.t("settings.messengers.speed.description")}</p>
          <label class="flex items-center gap-2">
            <TextInputV2
              type="number"
              min={PACE_MIN}
              max={PACE_MAX}
              value={cps()}
              invalid={value() === undefined}
              aria-label={language.t("settings.messengers.speed.title", { label: props.account.label })}
              onInput={(event) => {
                setCps(event.currentTarget.value)
                setError(undefined)
              }}
            />
            <span class="settings-v2-field-description">{language.t("settings.messengers.speed.unit")}</span>
          </label>
          <p class="settings-v2-field-description">
            {language.t("settings.messengers.speed.human", { default: String(PACE_DEFAULT) })}
          </p>
          <Show when={risky()}>
            <p class="settings-v2-server-dialog-error">{language.t("settings.messengers.speed.warning")}</p>
          </Show>
          <Show when={error()}>
            <span class="settings-v2-server-dialog-error">{error()}</span>
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" onClick={() => dialog.close()} disabled={busy()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" onClick={() => void save()} disabled={busy()}>
          {language.t("common.save")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
