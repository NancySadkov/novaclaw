import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

/**
 * Token, cost and tool usage rolled up across the instance's sessions.
 *
 * 🔴 **This exists so the numbers can leave the CLI.** `nova-cli stats` was an analytics dashboard
 * on the developer surface and nowhere else, which principle 7 rules out — the shell is where a
 * dashboard belongs, and a CLI is headless-only. The aggregation moved to
 * `@novaclaw/core/usage-stats` first (the fold could not be reached from `packages/app`, which
 * cannot import `packages/novaclaw`); this is the second of the four steps, and the page is the
 * third. The command is deleted last, in that order, because building the replacement before
 * removing the thing it replaces is what the ledger entry asks for.
 *
 * ⚠️ Read-only and instance-wide, so there is no resource in the path and nothing to narrow — the
 * numbers describe the instance the caller is already authorized against.
 */
const Tokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cache: Schema.Struct({ read: Schema.Finite, write: Schema.Finite }),
})

/** Per-model rollup. `output` folds reasoning in, matching what the CLI has always reported. */
const ModelUsage = Schema.Struct({
  messages: Schema.Finite,
  tokens: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    cache: Schema.Struct({ read: Schema.Finite, write: Schema.Finite }),
  }),
  cost: Schema.Finite,
})

export const UsageSummary = Schema.Struct({
  totalSessions: Schema.Finite,
  totalMessages: Schema.Finite,
  totalCost: Schema.Finite,
  totalTokens: Tokens,
  toolUsage: Schema.Record(Schema.String, Schema.Finite),
  modelUsage: Schema.Record(Schema.String, ModelUsage),
  dateRange: Schema.Struct({ earliest: Schema.Finite, latest: Schema.Finite }),
  days: Schema.Finite,
  costPerDay: Schema.Finite,
  tokensPerSession: Schema.Finite,
  medianTokensPerSession: Schema.Finite,
})

/**
 * ⚠️ `days` is optional and means ALL TIME when absent, which is the CLI's own default. A window of
 * 0 is not the same as no window and must not be normalized into one — `--days 0` asks for nothing,
 * omitting it asks for everything.
 */
const UsageQuery = Schema.Struct({
  ...WorkspaceRoutingQuery.fields,
  days: Schema.optional(Schema.FiniteFromString),
  project: Schema.optional(Schema.String),
})

export const UsageApi = HttpApi.make("usage").add(
  HttpApiGroup.make("usage")
    .add(
      HttpApiEndpoint.get("summary", "/api/usage", {
        query: UsageQuery,
        success: described(
          UsageSummary,
          "Token, cost and tool usage across this instance's sessions, optionally windowed to the last N days",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "usage.summary",
          summary: "Usage summary",
          description:
            "Roll up sessions, messages, cost, tokens, per-model and per-tool usage. Reads every session's message list, so it is a report rather than a hot path.",
        }),
      ),
    )
    /**
     * ⚠️ All three, in this order, and the first is why the route 500'd before it existed.
     * `InstanceState.context` reads `InstanceRef`, which `InstanceContextMiddleware` provides per
     * request from the routed workspace — a group that does not DECLARE the middleware never gets
     * it, and the handler dies with "InstanceRef not provided" rather than failing to compile. The
     * layer being registered in `server.ts` is necessary and not sufficient.
     */
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization)
    .annotateMerge(OpenApi.annotations({ title: "Usage" })),
)
