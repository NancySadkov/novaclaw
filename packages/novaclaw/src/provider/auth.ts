import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { serviceUse } from "@novaclaw/core/effect/service-use"
import { Auth } from "@/auth"
import { optional } from "@novaclaw/core/schema"
import { ProviderV2 } from "@novaclaw/core/provider"
import { Effect, Layer, Context, Schema } from "effect"

// ⚠️ HALF-DARK — SLATED FOR REMOVAL. This service had exactly ONE feed: the V1 plugin `auth` hook,
// which was deleted with the rest of the V1 plugin arm. There is no V2 seam for provider auth
// methods, and NovaClaw shipped zero V1 plugins, so nothing user-facing changes: `methods()` now
// returns `{}` for every install, `authorize` has no method to run, and `callback` has nothing
// pending. The service, its schemas and its three routes survive only so the wire surface does not
// churn twice; the follow-up unit deletes them together with `/provider/{id}/auth*` from the HTTP
// API + the generated OpenAPI/SDK. Do NOT build on this — register provider credentials through
// `Auth` (`/auth`) instead.

const When = Schema.Struct({
  key: Schema.String,
  op: Schema.Literals(["eq", "neq"]),
  value: Schema.String,
})

const TextPrompt = Schema.Struct({
  type: Schema.Literal("text"),
  key: Schema.String,
  message: Schema.String,
  placeholder: optional(Schema.String),
  when: optional(When),
})

const SelectOption = Schema.Struct({
  label: Schema.String,
  value: Schema.String,
  hint: optional(Schema.String),
})

const SelectPrompt = Schema.Struct({
  type: Schema.Literal("select"),
  key: Schema.String,
  message: Schema.String,
  options: Schema.Array(SelectOption),
  when: optional(When),
})

const Prompt = Schema.Union([TextPrompt, SelectPrompt])

export class Method extends Schema.Class<Method>("ProviderAuthMethod")({
  type: Schema.Literals(["oauth", "api"]),
  label: Schema.String,
  prompts: optional(Schema.Array(Prompt)),
}) {}

export const Methods = Schema.Record(Schema.String, Schema.Array(Method))
export type Methods = typeof Methods.Type

export class Authorization extends Schema.Class<Authorization>("ProviderAuthAuthorization")({
  url: Schema.String,
  method: Schema.Literals(["auto", "code"]),
  instructions: Schema.String,
}) {}

export const AuthorizeInput = Schema.Struct({
  method: Schema.Finite.annotate({ description: "Auth method index" }),
  inputs: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({ description: "Prompt inputs" }),
})
export type AuthorizeInput = Schema.Schema.Type<typeof AuthorizeInput>

export const CallbackInput = Schema.Struct({
  method: Schema.Finite.annotate({ description: "Auth method index" }),
  code: Schema.optional(Schema.String).annotate({ description: "OAuth authorization code" }),
})
export type CallbackInput = Schema.Schema.Type<typeof CallbackInput>

export class OauthMissing extends Schema.TaggedErrorClass<OauthMissing>()("ProviderAuthOauthMissing", {
  providerID: ProviderV2.ID,
}) {}

export class OauthCodeMissing extends Schema.TaggedErrorClass<OauthCodeMissing>()("ProviderAuthOauthCodeMissing", {
  providerID: ProviderV2.ID,
}) {}

export class OauthCallbackFailed extends Schema.TaggedErrorClass<OauthCallbackFailed>()(
  "ProviderAuthOauthCallbackFailed",
  {},
) {}

export class ValidationFailed extends Schema.TaggedErrorClass<ValidationFailed>()("ProviderAuthValidationFailed", {
  field: Schema.String,
  message: Schema.String,
}) {}

export type Error = Auth.AuthError | OauthMissing | OauthCodeMissing | OauthCallbackFailed | ValidationFailed

export interface Interface {
  readonly methods: () => Effect.Effect<Methods>
  readonly authorize: (
    input: {
      providerID: ProviderV2.ID
    } & AuthorizeInput,
  ) => Effect.Effect<Authorization | undefined, Error>
  readonly callback: (input: { providerID: ProviderV2.ID } & CallbackInput) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/ProviderAuth") {}

export const use = serviceUse(Service)

export const layer: Layer.Layer<Service> = Layer.succeed(
  Service,
  Service.of({
    // No feed: the V1 `auth` hook was the only producer of provider auth methods.
    methods: () => Effect.succeed({} as Methods),
    // Nothing to authorize against, so the honest answer is "this provider has no auth flow".
    authorize: () => Effect.succeed(undefined),
    // No authorize ever succeeded, so there is never a pending OAuth exchange to complete.
    callback: (input) => Effect.fail(new OauthMissing({ providerID: input.providerID })),
  }),
)

export const defaultLayer = layer

export const node = LayerNode.make({ service: Service, layer: layer, deps: [] })

export * as ProviderAuth from "./auth"
