import { EOL } from "os"
import { basename } from "path"
import { Effect } from "effect"
import { Agent } from "../../../agent/agent"
import { fail } from "../../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"

// F1f: `debug agent` now dumps the resolved agent CONFIG only. Its former `--tool` enumerate/execute
// was the last consumer of the V1 `ToolRegistry` + the duplicate-of-core V1 tool cluster (both
// retired). The effective tool set is available via the core-backed `GET /experimental/tool[/ids]`
// route (P2a), or by running a real turn; tool enablement is implied by the agent's `permission`.
export const debugAgent = Effect.fn("Cli.debug.agent")(function* (args: { name: string }) {
  const ctx = yield* InstanceRef
  if (!ctx) return
  const agent = yield* Agent.Service.use((svc) => svc.get(args.name))
  if (!agent) {
    process.stderr.write(
      `Agent ${args.name} not found, run '${basename(process.execPath)} agent list' to get an agent list` + EOL,
    )
    return yield* fail("", 1)
  }
  process.stdout.write(JSON.stringify(agent, null, 2) + EOL)
})
