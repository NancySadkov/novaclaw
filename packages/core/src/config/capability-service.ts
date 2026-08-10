export * as ConfigCapabilityService from "./capability-service"

import { Schema } from "effect"
import { PositiveInt } from "../schema"
import { ConfigDevice } from "./device"

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export class HttpTransport extends Schema.Class<HttpTransport>("ConfigV2.CapabilityService.HttpTransport")({
  type: Schema.Literal("streamable-http"),
  url: Schema.String,
  /** Audience bound into the eventual credential handle; never a token or header value. */
  audience: Schema.String.pipe(Schema.optional),
}) {}

export class StdioTransport extends Schema.Class<StdioTransport>("ConfigV2.CapabilityService.StdioTransport")({
  type: Schema.Literal("stdio"),
  command: Schema.Array(Schema.String),
  /** Names of inherited environment variables the worker requires; values never enter config. */
  credential_env: Schema.Array(Schema.String).pipe(Schema.optional),
}) {}

export const Transport = Schema.Union([HttpTransport, StdioTransport]).pipe(Schema.toTaggedUnion("type"))
export type Transport = typeof Transport.Type

export class Limits extends Schema.Class<Limits>("ConfigV2.CapabilityService.Limits")({
  context_tokens: PositiveInt.pipe(Schema.optional),
  input_bytes: PositiveInt.pipe(Schema.optional),
  handle_bytes: PositiveInt.pipe(Schema.optional),
}) {}

export class Resources extends Schema.Class<Resources>("ConfigV2.CapabilityService.Resources")({
  estimated_resident_bytes: NonNegativeInt,
  estimated_peak_bytes: NonNegativeInt,
}) {}

export class Health extends Schema.Class<Health>("ConfigV2.CapabilityService.Health")({
  interval_ms: PositiveInt.pipe(Schema.optional),
  timeout_ms: PositiveInt.pipe(Schema.optional),
}) {}

/**
 * One external capability service declaration. Dynamic load/health state deliberately does not live
 * here: config is operator intent, while the governor owns observed state. Every outage-relevant
 * static fact does live here so PATCH /config can repair it without a restart.
 */
export class Info extends Schema.Class<Info>("ConfigV2.CapabilityService")({
  capabilities: Schema.Array(Schema.NonEmptyString),
  transport: Transport,
  locality: ConfigDevice.Locality,
  /** MIME types or closed input type names accepted by the service. Empty/absent means unspecified. */
  types: Schema.Array(Schema.String).pipe(Schema.optional),
  protocol_revision: Schema.String.pipe(Schema.optional),
  limits: Limits.pipe(Schema.optional),
  resources: Resources,
  /** Maximum waiting requests for this service. Defaults to the governor's conservative bound. */
  queue_limit: PositiveInt.pipe(Schema.optional),
  warmup_timeout_ms: PositiveInt.pipe(Schema.optional),
  idle_timeout_ms: PositiveInt.pipe(Schema.optional),
  health: Health.pipe(Schema.optional),
  /** Optional shared-device id used by the resource governor; not inferred from the endpoint. */
  device: Schema.String.pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
}) {}
