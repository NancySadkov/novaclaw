export * as ConfigProviderConnection from "./provider-connection"

import { Schema } from "effect"
import { ConfigAnnotation } from "@novaclaw/schema/config-annotation"

/** Five minutes without a single streamed event means the connection is no longer useful. */
export const DEFAULT_STALL_TIMEOUT_MS = 300_000

/** Keep the repair knob useful without allowing an accidental multi-hour silent wait. */
const StallTimeout = Schema.Int.check(Schema.isBetween({ minimum: 30_000, maximum: 1_800_000 }))

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
}) {}

export function stallTimeoutMs(info: Info | undefined): number {
  return info?.stall_timeout_ms ?? DEFAULT_STALL_TIMEOUT_MS
}
