import { LayerNode } from "@novaclaw/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@novaclaw/core/schema"
import { Global } from "@novaclaw/core/global"
import { FSUtil } from "@novaclaw/core/fs-util"
import { CredentialCipher } from "@novaclaw/core/credential-cipher"

export const OAUTH_DUMMY_KEY = "novaclaw-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")
const fileAad = "novaclaw:auth.json"

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/Auth") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const cipher = yield* CredentialCipher.Service
    const decode = Schema.decodeUnknownOption(Info)

    /**
     * 🔴 The unwind of app-managed encryption, continued (`todo/code-review.md`, NC-REL-030).
     *
     * Decision §5 of `decisions-v0.2.0.md` — recorded after the cipher landed unexplained — says
     * secrets stay plaintext under OS account protection, because no keyring exists in every run
     * mode NovaClaw ships. What shipped was a key FILE beside this one, which buys none of the
     * security a keyring would and strands `novaclaw serve`, the CLI and backup/restore exactly as
     * the decision said it would.
     *
     * ⚠️ The 0o600 mode is the protection, and it is the one that was always doing the work.
     */
    const write = (data: unknown) =>
      fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))

    const all = Effect.fn("Auth.all")(function* () {
      if (process.env.NOVACLAW_AUTH_CONTENT) {
        try {
          return JSON.parse(process.env.NOVACLAW_AUTH_CONTENT)
        } catch (err) {}
      }

      const raw = yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => undefined))
      if (raw === undefined) return {}
      const opened = yield* CredentialCipher.decryptJson(cipher, raw, fileAad).pipe(
        Effect.mapError(fail("Failed to decrypt auth data")),
      )
      // ⚠️ The DRAIN, and the condition is now the opposite one. This used to encrypt a plaintext
      // file on first read; it writes an OPENED file back as plaintext, so existing ciphertext
      // leaves while the key is still present. Stopping the writes without this would strand every
      // instance that has already logged in to a provider.
      if (opened.encrypted) yield* write(opened.value)
      const data = opened.value as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      yield* write({ ...data, [norm]: info })
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      delete data[key]
      delete data[norm]
      yield* write(data)
    })

    return Service.of({ get, all, set, remove })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(CredentialCipher.defaultLayer))

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node, CredentialCipher.node] })

export * as Auth from "."
