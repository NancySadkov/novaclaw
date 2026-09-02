import { Credential } from "@novaclaw/core/credential"
import { CredentialCipher } from "@novaclaw/core/credential-cipher"
import { CredentialRepair } from "@novaclaw/core/credential/repair"
import { Database } from "@novaclaw/core/database/database"
import { Global } from "@novaclaw/core/global"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { Integration } from "@novaclaw/core/integration"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { CredentialApi, handlerLayer } from "../handler-api"

export const CredentialHandler = handlerLayer(
  HttpApiBuilder.group(CredentialApi, "server.credential", (handlers) =>
    handlers
      /**
       * 🔴 NC-REL-030(b) — the only place that says a lost `credential.key` has cost the user
       * something. Boot survival (a) made an unreadable secret fail closed instead of fatal, which
       * turned a loud failure into a silent one: providers stop authenticating and nothing explains
       * why.
       *
       * ⚠️ Two sources, joined here rather than merged into one scanner. `Credential` owns its
       * table and AAD; `SettingsConfigStore` owns its nested protected paths and theirs. Deriving
       * either from outside would be a second copy of a constant whose only failure symptom is
       * every row reported unreadable — catastrophic-looking damage caused by a wrong string.
       */
      .handle(
        "credential.repair.status",
        Effect.fn(function* () {
          const { db } = yield* Database.Service
          const cipher = yield* CredentialCipher.Service
          const settings = yield* SettingsConfigStore.Service
          const found = CredentialRepair.dedupe([
            ...(yield* CredentialRepair.scan([
              Credential.repairSource(db, cipher),
              // The identity secret is the one this instance cannot re-enter, so a scan that omits
              // it reports 0 damaged while the unrecoverable one sits there.
              InstanceIdentityStore.repairSource(db, cipher),
            ])),
            ...(yield* settings.unreadable().pipe(Effect.catchCause(() => Effect.succeed([])))),
          ])
          const global = yield* Global.Service
          return { unreadable: found, notice: CredentialRepair.notice(found, global.state) }
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
