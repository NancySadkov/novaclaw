import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

// Raw-fetch helpers for the instance-global `/api/messenger/*` endpoints (notes/messenger-plan.md
// §5) — what the Settings → Messengers tab binds to. Plain fetch with the createSdkForServer auth
// recipe, exactly like memory-api.ts / registry-api.ts. Secrets flow IN through `secret` only and
// never come back (responses carry credentialID references); the login flow's session credential
// never touches the client at all — the wire carries only the phone/code the user types.

export interface DriverPrompt {
  readonly type: "text" | "select"
  readonly key: string
  readonly message: string
  readonly placeholder?: string
  readonly options?: readonly { readonly label: string; readonly value: string; readonly hint?: string }[]
}

export interface DriverMeta {
  readonly id: string
  readonly name: string
  readonly icon: string
  readonly auth: "login" | "key" | "none"
  readonly settings: readonly DriverPrompt[]
  readonly loginPrompts?: readonly DriverPrompt[]
  /** For `login` drivers: "code" (default) = the user types a code the provider sends; "browser" =
   *  an auth-code + loopback flow (Gmail "Sign in with Google") where NovaClaw opens the browser and
   *  catches the redirect — nothing to type, the wizard just waits + polls. */
  readonly loginStyle?: "code" | "browser"
  /** Plain-words recipe for GETTING this driver's credential (creating a Discord bot, asking
   *  BotFather for a token). Shown as numbered steps in the Add-account dialog — a normal person
   *  should never have to leave the app to find out what to paste here. */
  readonly setup?: {
    readonly url?: string
    readonly urlLabel?: string
    readonly steps: readonly string[]
  }
}

export type AccountStatus =
  | { readonly state: "disabled" | "airgapped" | "connecting" | "connected" }
  | { readonly state: "backoff"; readonly until: number; readonly message: string }
  | { readonly state: "challenge"; readonly message: string }
  | { readonly state: "error"; readonly message: string }

export interface AccountInfo {
  readonly id: string
  readonly driverID: string
  readonly label: string
  readonly enabled: boolean
  readonly credentialID?: string
  readonly settings: Record<string, string>
}

export interface AccountWithStatus {
  readonly account: AccountInfo
  readonly status: AccountStatus
}

export interface LoginAttempt {
  readonly attemptID: string
  readonly instructions: string
  /** A scannable `data:image/png;base64,…` code, when the step is scanned rather than typed. */
  readonly qrImage?: string
  readonly time: { readonly created: number; readonly expires: number }
}

/** The live state of an attempt. `instructions`/`qrImage` are the step's CURRENT presentation —
 *  WhatsApp rotates its linked-device QR every ~20s and a stale one silently will not scan, so the
 *  wizard polls this and re-renders rather than trusting what `begin` handed back. */
export interface LoginStatus {
  readonly status: "pending" | "complete" | "failed" | "expired"
  readonly message?: string
  readonly instructions?: string
  readonly qrImage?: string
  readonly time: { readonly created: number; readonly expires: number }
}

export interface PairingCode {
  readonly code: string
  readonly expiresAt: number
}

/** A 400 from the messenger routes — `kind` distinguishes a retryable login miss
 *  (`messenger_login_retry`: the attempt is still pending, just re-ask for the code). */
export class MessengerApiError extends Error {
  constructor(
    message: string,
    readonly kind: string | undefined,
    readonly status: number,
  ) {
    super(message)
    this.name = "MessengerApiError"
  }
  get retryableLogin(): boolean {
    return this.kind === "messenger_login_retry"
  }
}

function headersFor(server: ServerConnection.HttpBase): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(server.password
      ? { Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}` }
      : {}),
  }
}

async function call<T>(
  server: ServerConnection.HttpBase,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  route: string,
  body?: unknown,
): Promise<T> {
  const url = new URL(route, server.url.endsWith("/") ? server.url : `${server.url}/`)
  const res = await fetch(url, {
    method,
    headers: headersFor(server),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    let message = `${method} ${route} failed (${res.status})`
    let kind: string | undefined
    try {
      const parsed = JSON.parse(text) as { message?: string; kind?: string }
      if (typeof parsed.message === "string") message = parsed.message
      if (typeof parsed.kind === "string") kind = parsed.kind
    } catch {
      if (text) message = text
    }
    throw new MessengerApiError(message, kind, res.status)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export function messengerDrivers(server: ServerConnection.HttpBase) {
  return call<DriverMeta[]>(server, "GET", "api/messenger/driver")
}

export function messengerAccounts(server: ServerConnection.HttpBase) {
  return call<AccountWithStatus[]>(server, "GET", "api/messenger/account")
}

export function messengerCreateAccount(
  server: ServerConnection.HttpBase,
  input: { driverID: string; label: string; enabled: boolean; settings: Record<string, string>; secret?: string },
) {
  return call<AccountInfo>(server, "POST", "api/messenger/account", {
    driverID: input.driverID,
    label: input.label,
    enabled: input.enabled,
    settings: input.settings,
    ...(input.secret ? { secret: input.secret } : {}),
  })
}

export function messengerUpdateAccount(
  server: ServerConnection.HttpBase,
  accountID: string,
  patch: { label?: string; enabled?: boolean; settings?: Record<string, string>; secret?: string },
) {
  return call<void>(server, "PATCH", `api/messenger/account/${accountID}`, patch)
}

export function messengerRemoveAccount(server: ServerConnection.HttpBase, accountID: string) {
  return call<void>(server, "DELETE", `api/messenger/account/${accountID}`)
}

export function messengerMintPairing(
  server: ServerConnection.HttpBase,
  accountID: string,
  trust: "operator" | "client",
) {
  return call<PairingCode>(server, "POST", `api/messenger/account/${accountID}/pair`, { trust })
}

export interface ChatInfo {
  readonly accountID: string
  readonly chatID: string
  readonly kind: "dm" | "group" | "channel" | "thread" | "mailbox" | "topic"
  readonly title: string
  readonly lastSeen: number
}

export interface ChatsResult {
  readonly ok: boolean
  readonly chats: readonly ChatInfo[]
  readonly reason?: string
}

export type BindingTrust = "operator" | "client" | "audience"

export interface BindingInfo {
  readonly id: string
  readonly accountID: string
  readonly chatID: string
  readonly sessionID: string
  readonly trust: BindingTrust
  readonly status: "active" | "paused"
}

export function messengerAccountChats(server: ServerConnection.HttpBase, accountID: string) {
  return call<ChatsResult>(server, "GET", `api/messenger/account/${accountID}/chats`)
}

export interface BindingRow {
  readonly binding: BindingInfo
  readonly chatTitle?: string
}

export function messengerBindings(server: ServerConnection.HttpBase) {
  return call<BindingRow[]>(server, "GET", "api/messenger/binding")
}

export function messengerCreateBinding(
  server: ServerConnection.HttpBase,
  input: { accountID: string; chatID: string; sessionID: string; trust: BindingTrust; steal?: boolean },
) {
  return call<BindingInfo>(server, "POST", "api/messenger/binding", input)
}

export function messengerRemoveBinding(server: ServerConnection.HttpBase, bindingID: string) {
  return call<void>(server, "DELETE", `api/messenger/binding/${bindingID}`)
}

export function messengerLoginBegin(
  server: ServerConnection.HttpBase,
  accountID: string,
  inputs: Record<string, string>,
) {
  return call<LoginAttempt>(server, "POST", `api/messenger/account/${accountID}/login`, { inputs })
}

export function messengerLoginStatus(server: ServerConnection.HttpBase, attemptID: string) {
  return call<LoginStatus>(server, "GET", `api/messenger/login/${attemptID}`)
}

export function messengerLoginComplete(server: ServerConnection.HttpBase, attemptID: string, code: string) {
  return call<void>(server, "POST", `api/messenger/login/${attemptID}/complete`, { code })
}

export function messengerLoginCancel(server: ServerConnection.HttpBase, attemptID: string) {
  return call<void>(server, "DELETE", `api/messenger/login/${attemptID}`)
}
