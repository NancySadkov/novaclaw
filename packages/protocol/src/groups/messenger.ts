import { Messenger } from "@novaclaw/schema/messenger"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"

// The Messenger module's HTTP surface (notes/messenger-plan.md §5), P0 slice: driver discovery +
// account CRUD. INSTANCE-GLOBAL routes (no location middleware — accounts span locations, like
// health). Secrets ride the `secret` payload field into the credential store and NEVER come back
// out: every response carries `credentialID` references only. Chats/bindings/pairing land with
// P1/P3.

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
  .annotateMerge(
    OpenApi.annotations({ title: "messenger", description: "Messenger driver discovery and account routes." }),
  )
