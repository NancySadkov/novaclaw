import { AgentJail } from "@novaclaw/core/agent-jail"
import { Git } from "@novaclaw/core/git"
import { Offline } from "@novaclaw/core/offline"
import { Shell } from "@novaclaw/core/shell"
import { which } from "@novaclaw/core/util/which"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

const status = () => {
  const agentShell = Shell.agentDefault()
  const bash = process.platform === "win32" ? (Shell.name(agentShell) === "bash" ? agentShell : null) : (which("bash") ?? null)
  const git = Git.binary()
  return {
    platform: process.platform,
    agentShell,
    bash,
    git: git === "git" ? (which("git") ?? null) : git,
    // `posture()` memoises for the process — ONE `bwrap` spawn per instance, not one per request,
    // and it shares that cache with the `bash` tool's own probe so the screen and the shell can never
    // disagree about one host. Consequence worth knowing: installing the AppArmor profile on a live
    // Linux instance does not change this report until restart.
    jail: AgentJail.postureWire(AgentJail.posture()),
    // Memoised like `posture()` and for the same reason — it reads /proc and spawns
    // systemd-detect-virt, and the answer changes about as often as the machine reboots.
    enclosure: AgentJail.enclosure(),
  }
}

export const shellHandlers = HttpApiBuilder.group(InstanceHttpApi, "shell", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "status",
        Effect.fn("ShellHttpApi.status")(function* () {
          return status()
        }),
      )
      .handle(
        "offline",
        Effect.fn("ShellHttpApi.offline")(function* () {
          // Read the manifest off the SAME service that enforces the guard, so the status surface
          // cannot disagree with what is actually blocking (v0.2.0 ruling 3: a fault is never
          // described falsely). This used to call `loadPolicy({ configDir })` per request, which
          // recomputes the policy from its sources — two `readRowsSync` calls, i.e. two synchronous
          // sqlite open/close pairs, on every poll of a UI-polled endpoint. Since the policy became
          // a live module-level ref that a config write refreshes, re-deriving it here bought
          // nothing: `offline.manifest()` reads that ref.
          const offline = yield* Offline.Service
          return offline.manifest()
        }),
      )
  }),
)
