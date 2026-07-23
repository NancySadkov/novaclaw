import { Messenger } from "@novaclaw/schema/messenger"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"

// The Messenger module's HTTP surface (notes/messenger-plan.md §5), P0 slice: driver discovery +
// account CRUD. INSTANCE-GLOBAL routes (no location middleware — accounts span locations, like
// health). Secrets ride the `secret` payload field into the credential store and NEVER come back
// out: every response carries `credentialID` references only. P3 adds the picker's data (an
// account's chats) + the binding surface (list/create/remove — trust always explicit, edge #3
// steal semantics). P1.7 adds the `login`-auth attempt trio (begin/status/complete + cancel) for drivers
// where the account is the USER'S OWN (Telegram user-account): the session credential the flow
// yields is stored server-side; the wire only ever carries the phone/code the user types.

const AccountWithStatus = Schema.Struct({
  account: Messenger.AccountInfo,
  status: Messenger.AccountStatus,
}).annotate({ identifier: "Messenger.AccountWithStatus" })

export const MessengerGroup = HttpApiGroup.make("server.messenger")
  .add(
    HttpApiEndpoint.get("messenger.driver.list", "/api/messenger/driver", {
      success: Schema.Array(Messenger.DriverMeta),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.messenger.driver.list",
        summary: "List messenger drivers",
        description: "Retrieve the installed messenger platform drivers and their capabilities.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("messenger.account.list", "/api/messenger/account", {
      success: Schema.Array(AccountWithStatus),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.messenger.account.list",
        summary: "List messenger accounts",
        description: "Retrieve every configured messenger account with its live connection status.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("messenger.account.create", "/api/messenger/account", {
      payload: Schema.Struct({
        driverID: Schema.String,
        label: Schema.String,
        enabled: Schema.Boolean,
        settings: Schema.Record(Schema.String, Schema.String),
        secret: Schema.optional(Schema.String),
      }),
      success: Messenger.AccountInfo,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.messenger.account.create",
        summary: "Create messenger account",
        description:
          "Configure a messenger account for an installed driver. The optional secret (bot token, API key) is stored in the credential store and never returned.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("messenger.account.update", "/api/messenger/account/:accountID", {
      params: { accountID: Messenger.AccountID },
      payload: Schema.Struct({
        label: Schema.optional(Schema.String),
        enabled: Schema.optional(Schema.Boolean),
        settings: Schema.optional(Schema.Record(Schema.String, Schema.String)),
        secret: Schema.optional(Schema.String),
      }),
      success: HttpApiSchema.NoContent,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.messenger.account.update",
        summary: "Update messenger account",
        description: "Update a messenger account's label, enabled state, settings, or stored secret.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("messenger.account.remove", "/api/messenger/account/:accountID", {
      params: { accountID: Messenger.AccountID },
      success: HttpApiSchema.NoContent,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.messenger.account.remove",
        summary: "Remove messenger account",
        description:
          "Remove a messenger account, its stored credential, seen chats, contacts, bindings, and cursor.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("messenger.account.pair", "/api/messenger/account/:accountID/pair", {
      params: { accountID: Messenger.AccountID },
      payload: Schema.Struct({ trust: Schema.Literals(["operator", "client"]) }),
      success: Schema.Struct({ code: Schema.String, expiresAt: Schema.Number }),
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.messenger.account.pair",
        summary: "Mint pairing code",
        description:
          "Mint a single-use, 10-minute pairing code. A remote sender redeems it with /pair <code> in a DM to become a paired contact at the chosen trust.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("messenger.account.chats", "/api/messenger/account/:accountID/chats", {
      params: { accountID: Messenger.AccountID },
      success: Schema.Struct({
        ok: Schema.Boolean,
        chats: Schema.Array(Messenger.ChatInfo),
        reason: Schema.optional(Schema.String),
      }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.messenger.account.chats",
        summary: "List an account's chats",
        description:
          "The account's known chats — the live driver list where the platform allows enumeration (seeding the seen-cache), else the seen-cache. `ok:false` carries a plain-words reason (not connected, nothing seen yet).",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("messenger.binding.list", "/api/messenger/binding", {
      success: Schema.Array(
        Schema.Struct({
          binding: Messenger.BindingInfo,
          chatTitle: Schema.optional(Schema.String),
        }),
      ),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.messenger.binding.list",
        summary: "List chat bindings",
        description:
          "Every live session↔chat binding on this instance, with the chat's human title from the seen-cache where known.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("messenger.binding.create", "/api/messenger/binding", {
      payload: Schema.Struct({
        accountID: Messenger.AccountID,
        chatID: Schema.String,
        sessionID: Schema.String,
        trust: Messenger.Trust,
        steal: Schema.optional(Schema.Boolean),
      }),
      success: Messenger.BindingInfo,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.messenger.binding.create",
        summary: "Bind a session to a chat",
        description:
          "Link a session to a remote chat at an explicit trust tier (operator | client | audience — always user-chosen, never inferred). One session per chat: if the chat is already bound the call fails naming the holding session; pass steal:true to rebind deliberately.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("messenger.binding.remove", "/api/messenger/binding/:bindingID", {
      params: { bindingID: Messenger.BindingID },
      success: HttpApiSchema.NoContent,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.messenger.binding.remove",
        summary: "Unbind a chat",
        description: "Remove a session↔chat binding. The chat stops driving (or reporting to) the session immediately.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("messenger.login.begin", "/api/messenger/account/:accountID/login", {
      params: { accountID: Messenger.AccountID },
      payload: Schema.Struct({ inputs: Schema.Record(Schema.String, Schema.String) }),
      success: Messenger.LoginAttempt,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.messenger.login.begin",
        summary: "Begin messenger login",
        description:
          "Start a login-auth attempt for an account whose driver signs into the user's own messenger account (inputs answer the driver's loginPrompts — e.g. phone and optional 2FA password). The provider sends a confirmation code; complete the attempt with it.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("messenger.login.status", "/api/messenger/login/:attemptID", {
      params: { attemptID: Messenger.LoginAttemptID },
      success: Messenger.LoginStatus,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.messenger.login.status",
        summary: "Messenger login attempt status",
        description:
          "Retrieve the state of a pending or recently finished messenger login attempt, including the step's CURRENT instructions and scannable image — poll this while an attempt is pending, because providers may rotate what the user must act on (WhatsApp mints a fresh linked-device QR every ~20s).",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("messenger.login.complete", "/api/messenger/login/:attemptID/complete", {
      params: { attemptID: Messenger.LoginAttemptID },
      payload: Schema.Struct({ code: Schema.String }),
      success: HttpApiSchema.NoContent,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.messenger.login.complete",
        summary: "Complete messenger login",
        description:
          "Finish a login attempt with the confirmation code the provider sent. On success the session credential is stored and the account reconnects; a mistyped code keeps the attempt pending (error kind messenger_login_retry).",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("messenger.login.cancel", "/api/messenger/login/:attemptID", {
      params: { attemptID: Messenger.LoginAttemptID },
      success: HttpApiSchema.NoContent,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.messenger.login.cancel",
        summary: "Cancel messenger login",
        description: "Abandon a pending messenger login attempt and release its resources.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({ title: "messenger", description: "Messenger driver discovery and account routes." }),
  )
