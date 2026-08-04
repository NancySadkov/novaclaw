import type { ServerConnection } from "@/context/server"
import { InstanceFetchError, instanceFetch, instanceFetchList, type InstanceFault } from "@/utils/instance-fetch"

// The instance-global `/api/messenger/*` endpoints (notes/messenger-plan.md §5) — what the
// Settings → Messengers tab binds to. Secrets flow IN through `secret` only and never come back
// (responses carry credentialID references); the login flow's session credential never touches the
// client at all — the wire carries only the phone/code the user types.
//
// ⚠️ Base URL, auth, and fault decoding live in `utils/instance-fetch.ts`. This client keeps its own
// ERROR CLASS (below) because three call sites branch on `instanceof MessengerApiError`; what it no
// longer keeps is its own copy of how a fault is decoded.

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

/**
 * A 400 from the messenger routes — `kind` distinguishes a retryable login miss
 * (`messenger_login_retry`: the attempt is still pending, just re-ask for the code) from a chat
 * already bound elsewhere (`messenger_chat_bound`).
 *
 * ⚠️ It is a SUBCLASS of the seam's error rather than a parallel one. Three call sites test
 * `error instanceof MessengerApiError` — `settings-v2/messengers.tsx` (twice) and
 * `session/composer/session-composer-controls.ts` — and every one of them still works, because the
 * class survived the collapse even though its hand-rolled decoder did not. `kind`, `status` and
 * `message` are now inherited fields with exactly the same meanings.
 */
export class MessengerApiError extends InstanceFetchError {
  constructor(fault: InstanceFault) {
    super(fault)
    this.name = "MessengerApiError"
  }
  get retryableLogin(): boolean {
    return this.kind === "messenger_login_retry"
  }
}

const fault = (input: InstanceFault) => new MessengerApiError(input)

const call = <T>(
  server: ServerConnection.HttpBase,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  route: string,
  body?: unknown,
): Promise<T> => instanceFetch<T>(server, { method, route, body, fault })

/**
 * The non-list guard now lives on the seam (`instanceFetchList`) because the identical defect and
 * fix exist in `apps/persisted.ts` — the two were found together on 2026-07-28 and fixed twice.
 * It coerces rather than throws, and names the fault on the console rather than silently showing
 * nothing; the reasoning is written out where it now lives.
 */
const callList = <T>(server: ServerConnection.HttpBase, route: string, what: string): Promise<T[]> =>
  instanceFetchList<T>(server, { route, fault }, what)

export function messengerDrivers(server: ServerConnection.HttpBase) {
  return callList<DriverMeta>(server, "api/messenger/driver", "drivers")
}

export function messengerAccounts(server: ServerConnection.HttpBase) {
  return callList<AccountWithStatus>(server, "api/messenger/account", "accounts")
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
  return callList<BindingRow>(server, "api/messenger/binding", "bindings")
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
