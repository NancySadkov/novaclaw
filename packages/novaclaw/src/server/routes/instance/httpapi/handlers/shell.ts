import { Flag } from "@novaclaw/core/flag/flag"
import { Git } from "@novaclaw/core/git"
import { Global } from "@novaclaw/core/global"
import { layerManifest, loadPolicy } from "@novaclaw/core/offline"
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
          // GLOBAL config only (the machine-level chokepoint) — same source + flag-aware
          // dir as the Offline service, so the status matches what the guard enforces.
          return layerManifest(loadPolicy({ configDir: Flag.NOVACLAW_CONFIG_DIR ?? Global.Path.config }))
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
