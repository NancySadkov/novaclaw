export * as ConfigProviderConnection from "./provider-connection"

import { Schema } from "effect"
import { ConfigAnnotation } from "@novaclaw/schema/config-annotation"

/** Five minutes without a single streamed event means the connection is no longer useful. */
export const DEFAULT_STALL_TIMEOUT_MS = 300_000

/** Keep the repair knob useful without allowing an accidental multi-hour silent wait. */
const StallTimeout = Schema.Int.check(Schema.isBetween({ minimum: 30_000, maximum: 1_800_000 }))

/**
 * How long ONE capability-probe rung may take.
 *
 * Measured: a 4B thinking model on a laptop's Vulkan build needs **26.8 s** to think and then emit the
 * capture call. At a 30 s bound that rung timed out and a natively-capable model was recorded as
 * unmeasured, which durably routes it to the prompted channel — the probe measuring ITSELF.
 *
 * ⚠️ It is a KNOB rather than a constant because the number is a property of the user's slowest model
 * and their hardware, neither of which we can see from here. A bigger local model on a weaker box
 * takes longer than any figure we could compile in, and the failure is silent: a permanent wrong
 * channel with no error. Self-healing law — a value an outage hinges on lives in the store.
 */
export const DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS = 120_000

/** Enough for a very slow local model; bounded so a probe cannot hang a Settings screen for an hour. */
const CapabilityProbeTimeout = Schema.Int.check(Schema.isBetween({ minimum: 10_000, maximum: 900_000 }))

/**
 * How long the endpoint has to LIST its models, and to generate one token.
 *
 * ⚠️ Knobs for the same reason the capability bounds are: both are properties of the user's hardware.
 * A model still loading, or a large one on CPU, legitimately needs longer than any figure compiled in
 * here — and the failure looks like a broken endpoint, so the user retries forever instead of raising
 * a number. The generation message already tells them to *increase its connection timeout*; before
 * this key existed there was no timeout that sentence could have meant.
 */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000

/** Long enough for a cold local server to answer `/models`; short enough that a dead host fails fast. */
const DiscoveryTimeout = Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 120_000 }))

/** A one-token generation, but a cold model may have to load its weights first. */
export const DEFAULT_COMPLETION_TIMEOUT_MS = 45_000

const CompletionTimeout = Schema.Int.check(Schema.isBetween({ minimum: 5_000, maximum: 900_000 }))

/**
 * The completion budget each rung is given.
 *
 * Measured: at 64 tokens a reasoning model spent the whole budget before its first content token and
 * the JSON rung scored `unsupported` for a format the endpoint handles. 512 covers the models seen so
 * far, and a model that thinks longer needs a bigger number that only its operator can know.
 */
export const DEFAULT_CAPABILITY_PROBE_MAX_TOKENS = 512

/** Below ~128 the budget fault fires on healthy reasoning models; above 8192 a probe is a generation. */
const CapabilityProbeTokens = Schema.Int.check(Schema.isBetween({ minimum: 128, maximum: 8_192 }))

export class Info extends Schema.Class<Info>("ConfigV2.ProviderConnection")({
  // The declared default is the exported constant itself, never a copy of it: `config-projection.test.ts`
  // fails if the two ever disagree, which is the only thing that keeps a projected default honest.
  stall_timeout_ms: ConfigAnnotation.withDefault(
    StallTimeout.pipe(Schema.optional).annotate({
      description:
        "Maximum time to wait without any streamed provider event before NovaClaw stops the attempt (default 300000 ms; 30000-1800000)",
    }),
    { value: DEFAULT_STALL_TIMEOUT_MS, source: "config/provider-connection.ts DEFAULT_STALL_TIMEOUT_MS" },
  ),
  discovery_timeout_ms: ConfigAnnotation.withDefault(
    DiscoveryTimeout.pipe(Schema.optional).annotate({
      description: "Maximum time an endpoint has to list its models during a probe (default 5000 ms; 1000-120000).",
    }),
    { value: DEFAULT_DISCOVERY_TIMEOUT_MS, source: "config/provider-connection.ts DEFAULT_DISCOVERY_TIMEOUT_MS" },
  ),
  completion_timeout_ms: ConfigAnnotation.withDefault(
    CompletionTimeout.pipe(Schema.optional).annotate({
      description:
        "Maximum time a probe waits for the endpoint to generate its first token (default 45000 ms; " +
        "5000-900000). Raise it for a large local model that has to load before it can answer.",
    }),
    { value: DEFAULT_COMPLETION_TIMEOUT_MS, source: "config/provider-connection.ts DEFAULT_COMPLETION_TIMEOUT_MS" },
  ),
  capability_probe_timeout_ms: ConfigAnnotation.withDefault(
    CapabilityProbeTimeout.pipe(Schema.optional).annotate({
      description:
        "Maximum time one capability-probe rung may take before NovaClaw records it as unmeasured " +
        "(default 120000 ms; 10000-900000). Raise it for a slow local model that supports tools but " +
        "answers slowly.",
    }),
    {
      value: DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS,
      source: "config/provider-connection.ts DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS",
    },
  ),
  capability_probe_max_tokens: ConfigAnnotation.withDefault(
    CapabilityProbeTokens.pipe(Schema.optional).annotate({
      description:
        "Completion budget given to each capability-probe rung (default 512 tokens; 128-8192). Raise " +
        "it for a reasoning model that thinks past the budget before answering.",
    }),
    {
      value: DEFAULT_CAPABILITY_PROBE_MAX_TOKENS,
      source: "config/provider-connection.ts DEFAULT_CAPABILITY_PROBE_MAX_TOKENS",
    },
  ),
}) {}

export function stallTimeoutMs(info: Info | undefined): number {
  return info?.stall_timeout_ms ?? DEFAULT_STALL_TIMEOUT_MS
}

export function discoveryTimeoutMs(info: Info | undefined): number {
  return info?.discovery_timeout_ms ?? DEFAULT_DISCOVERY_TIMEOUT_MS
}

export function completionTimeoutMs(info: Info | undefined): number {
  return info?.completion_timeout_ms ?? DEFAULT_COMPLETION_TIMEOUT_MS
}

export function capabilityProbeTimeoutMs(info: Info | undefined): number {
  return info?.capability_probe_timeout_ms ?? DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS
}

export function capabilityProbeMaxTokens(info: Info | undefined): number {
  return info?.capability_probe_max_tokens ?? DEFAULT_CAPABILITY_PROBE_MAX_TOKENS
}
