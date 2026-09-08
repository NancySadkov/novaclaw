import type { ServerConnection } from "@/context/server"
import { instanceFetch } from "./instance-fetch"

/**
 * The pre-action policies installed in this NovaClaw, and what the routed folder asks for.
 *
 * The gap: *"policies have no management surface … Settings cannot list or toggle them."*
 * A policy can refuse a tool call, rewrite its arguments or hold it for approval, and until this
 * route existed there was no way to find out which guards were installed or whether the one your
 * folder declared was even running.
 */
export interface InstalledPolicy {
  readonly id: string
  /**
   * The policy's own one-line description.
   *
   * ⚠️ AUTHOR TEXT. Only NovaClaw's built-ins register today, but the provider interface is the one
   * a plugin implements — a surface renders this through `authorText`, never as our own sentence.
   */
  readonly describe: string
  /** `false` means a folder must name this policy in its `novaclaw.json` for it to run there. */
  readonly alwaysOn: boolean
  /** `false` marks an ADVISORY policy: if it fails to answer, the tool call still runs. */
  readonly safetyCritical: boolean
  /** Whether it is consulted at all. `config.tool_policy.<id>.enabled`; absent there means yes. */
  readonly enabled: boolean
}

export interface PolicyState {
  readonly installed: readonly InstalledPolicy[]
  /** The ids the routed folder's `novaclaw.json` opts into, verbatim. */
  readonly requested: readonly string[]
  /**
   * Requested ids that are NOT installed here.
   *
   * 🔴 Non-empty means every tool call in this folder is currently refused — the kernel fails closed
   * rather than run a folder unpoliced. A surface that did not say so would leave someone watching
   * every call fail with nothing on screen to explain it.
   */
  readonly missing: readonly string[]
  /**
   * Requested ids that are installed and switched OFF.
   *
   * 🔴 Also refuses every tool call here, and reported separately because the fix is the opposite
   * one: switch it back on, rather than go and install something.
   */
  readonly disabledButRequested: readonly string[]
  /** The `novaclaw.json` the requests came from, when a project governs this folder. */
  readonly file?: string
}

export function policyState(server: ServerConnection.HttpBase, directory: string, signal?: AbortSignal) {
  // The header channel, matching `GET /api/project` next door — the `/api/*` location surface reads
  // `x-novaclaw-directory`, and the route is verified through it end to end
  // (`httpapi-policy.test.ts`). The other spelling gets a 400 from a server that cannot see its
  // directory.
  return instanceFetch<PolicyState>(server, { route: "api/policy", directory, directoryVia: "header", signal })
}
