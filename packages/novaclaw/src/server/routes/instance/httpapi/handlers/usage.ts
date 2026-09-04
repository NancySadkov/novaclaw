import { UsageStats } from "@novaclaw/core/usage-stats"
import { InstanceState } from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

/**
 * The usage summary, served from the same fold the CLI prints.
 *
 * 🔴 **One producer, two renderers, and that is the whole point of the move.** `UsageStats.aggregate`
 * lives in `core` precisely so this route and `nova-cli stats` cannot drift into two answers to the
 * same question — which is the shape ruling 2 calls a fault described falsely, arriving as two
 * numbers where the user expects one. When the page lands and the command is deleted, this stays the
 * only caller.
 *
 * ⚠️ The instance's worktree is passed as the CURRENT ROOT, not as a filter. The fold uses it to resolve what
 * "this project" means when `project` is given; with no `project` it does not narrow anything, which
 * is why an instance-wide report is the default rather than an option.
 */
export const usageHandlers = HttpApiBuilder.group(InstanceHttpApi, "usage", (handlers) =>
  Effect.gen(function* () {
    return handlers.handle(
      "summary",
      Effect.fn("UsageHttpApi.summary")(function* (ctx) {
        const instance = yield* InstanceState.context
        return yield* UsageStats.aggregate(ctx.query.days, ctx.query.project, instance.worktree)
      }),
    )
  }),
)
