import { Credential } from "@novaclaw/core/credential"
import { CredentialRepair } from "@novaclaw/core/credential/repair"
import { Database } from "@novaclaw/core/database/database"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { Integration } from "@novaclaw/core/integration"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { CredentialApi, handlerLayer } from "../handler-api"

export const CredentialHandler = handlerLayer(
  HttpApiBuilder.group(CredentialApi, "server.credential", (handlers) =>
    handlers
      // Every instance-owned credential store contributes its validated paths.
      .handle(
        "credential.repair.status",
        Effect.fn(function* () {
          const { db } = yield* Database.Service

          const settings = yield* SettingsConfigStore.Service
          const found = CredentialRepair.dedupe([
            ...(yield* CredentialRepair.scan([
              Credential.repairSource(db),
              // The identity secret is the one this instance cannot re-enter, so a scan that omits
              // it reports 0 damaged while the unrecoverable one sits there.
              InstanceIdentityStore.repairSource(db),
            ])),
            ...(yield* settings
              .unreadable()
              .pipe(Effect.catchCause(() => Effect.succeed([{ path: "runtime-settings" }])))),
          ])
          return { unreadable: found, notice: CredentialRepair.notice(found) }
        }),
      )
      .handle(
        "credential.update",
        Effect.fn(function* (ctx) {
          yield* (yield* Integration.Service).connection.update(ctx.params.credentialID, { label: ctx.payload.label })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "credential.remove",
        Effect.fn(function* (ctx) {
          yield* (yield* Integration.Service).connection.remove(ctx.params.credentialID)
          return HttpApiSchema.NoContent.make()
        }),
      ),
  ),
)
