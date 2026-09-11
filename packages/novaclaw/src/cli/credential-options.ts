import type { Argv, InferredOptionTypes } from "yargs"
import { ServerLaunchCredential } from "@novaclaw/core/server-launch-credential"
import { withNetworkOptions } from "./network-options"

/**
 * The `--password` / `--username` pair every server-starting command offers.
 *
 * 🔴 These two options REPLACE the `NOVACLAW_SERVER_PASSWORD` / `NOVACLAW_SERVER_USERNAME` environment
 * variables, which the server no longer reads at all. An env var is not a configuration channel for a
 * local-first product: it is a process-wide global owned by whatever the launching shell last
 * exported, so an instance could come up authenticated — or open — depending on a line in someone's
 * profile. AGENTS.md principle 12 says the same thing from the user's side: a setting may never
 * require a value the user has no way to know, and an undocumented env var is exactly that.
 *
 * ⚠️ A password on the command line is visible in the process list on every OS. That trade is
 * deliberate and bounded: this is a LOOPBACK token for a single-user local instance, the alternative
 * (env) leaks to every child process and every debugger attached to the parent, and the durable
 * answer already exists — `server.password` in the settings store, which outranks a launch value at
 * auth time (`ServerAuth.resolve`) and is what Settings → Instances writes. The flag is the bootstrap
 * path, not where a long-lived deployment keeps its secret.
 */
const options = {
  password: {
    type: "string" as const,
    describe:
      "incoming API token for this instance (HTTP Basic password). Unset = the stored server.password, else an open server",
  },
  username: {
    type: "string" as const,
    describe: "HTTP Basic username to require alongside --password",
  },
}

export type CredentialOptions = InferredOptionTypes<typeof options>

export function withCredentialOptions<T>(yargs: Argv<T>) {
  return yargs.options(options)
}

/**
 * The full option set of a command that STARTS a server: the network binding plus the credential.
 *
 * 🔴 One composed helper, because `CommandSpec.web` and `cmd/web.ts` each carried their own builder for
 * the same command and the two disagreed in the type, not just in the text — the registry's
 * `lazyCommand` wrapper inferred its argument shape from the spec and then met the handler's from the
 * module, and yargs' generics refuse the mismatch. A command that starts a server should not be able to
 * offer half of its configuration, which this makes awkward to do by accident.
 */
export function withServerOptions<T>(yargs: Argv<T>) {
  return withCredentialOptions(withNetworkOptions(yargs))
}

/**
 * Record what argv asked for, BEFORE any auth layer is built.
 *
 * The order is the whole contract: the server's auth `Config` reads this holder lazily, so a command
 * that starts the server without calling this boots with no launch credential at all — which is the
 * honest "open server / stored token only" state, never a stale one.
 */
export function applyCredentialOptions(args: Partial<CredentialOptions>): void {
  ServerLaunchCredential.set({ password: args.password, username: args.username })
}

/**
 * Name an environment variable that this build deliberately ignores.
 *
 * 🔴 Silence here is the bug this exists to prevent. The owner's shell exports `NOVACLAW_SERVER_PASSWORD`
 * for other work; had the server simply stopped honouring it, that instance would have come up OPEN
 * while the person who exported it believed it was the reason a password worked. So an ignored
 * variable is announced, once, with the flag that does the job — the same rule `truthyUnlessDisabled`
 * records for a switch nobody can be expected to have heard of.
 */
export function warnOnIgnoredEnv(print: (line: string) => void = (line) => console.error(line)): void {
  for (const name of ["NOVACLAW_SERVER_PASSWORD", "NOVACLAW_SERVER_USERNAME"] as const) {
    if (process.env[name] === undefined) continue
    print(
      `note: ${name} is set in this shell and is IGNORED — NovaClaw takes its launch credential from ` +
        `--${name === "NOVACLAW_SERVER_PASSWORD" ? "password" : "username"} or from Settings → Instances, ` +
        `never from the environment.`,
    )
  }
}
