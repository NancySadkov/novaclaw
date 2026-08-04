import { AgentJail } from "@novaclaw/core/agent-jail"
import { Git } from "@novaclaw/core/git"
import { Offline } from "@novaclaw/core/offline"
import { Shell } from "@novaclaw/core/shell"
import { ShellBundle } from "@novaclaw/core/shell-bundle"
import { which } from "@novaclaw/core/util/which"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError } from "../errors"

// B11 handlers — thin lowering onto the ShellBundle module. Status is a sync probe;
// provision is the long download+extract (the UI awaits it with a spinner).

const status = () => {
  const bundle = ShellBundle.resolve()
  const agentShell = Shell.agentDefault()
  const bash = process.platform === "win32" ? (Shell.gitbash() ?? null) : (which("bash") ?? null)
  return {
    platform: process.platform,
    agentShell,
    bash,
    git: which("git") ?? bundle?.git ?? null,
    bundle: bundle
      ? {
          root: bundle.root,
          bash: bundle.bash,
          git: bundle.git,
          ...(bundle.version === undefined ? {} : { version: bundle.version }),
          ...(bundle.provisionedAt === undefined ? {} : { provisionedAt: bundle.provisionedAt }),
        }
      : null,
    provisionSupported: process.platform === "win32",
    // `posture()` memoises for the process — ONE `bwrap` spawn per instance, not one per request,
    // and it shares that cache with the `bash` tool's own probe so the screen and the shell can never
    // disagree about one host. Consequence worth knowing: installing the AppArmor profile on a live
    // Linux instance does not change this report until restart.
    jail: AgentJail.postureWire(AgentJail.posture()),
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
      .handle(
        "provision",
        Effect.fn("ShellHttpApi.provision")(function* () {
          yield* Effect.tryPromise({
            try: () => ShellBundle.provision(),
            catch: (error) =>
              new InvalidRequestError({
                message: error instanceof Error ? error.message : String(error),
                kind: "shell-provision",
              }),
          })
          // New binaries just landed — drop every shell/git resolution cache so the
          // running server picks them up without a restart.
          Shell.agentDefault.reset()
          Shell.preferred.reset()
          Shell.acceptable.reset()
          Git.binary.reset()
          return status()
        }),
      )
  }),
)
