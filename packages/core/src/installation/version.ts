import { VERSION } from "./version.gen"

declare global {
  const NOVACLAW_CHANNEL: string
}

/** The ONE runtime version. Sourced from the root package.json via the generated `version.gen.ts`,
 *  NOT from a build-time define: a define is absent under `bun test`, under `bun run src/index.ts`,
 *  and in any bundle whose builder forgot to set it — which is exactly how this silently reported
 *  "local" in the packaged desktop sidecar (its `build-node.ts` only ever defined the channel).
 *  A generated constant is correct in every one of those contexts with no build wiring at all. */
export const InstallationVersion = VERSION

/** The channel legitimately IS build-time — the same commit ships as dev, beta or prod — so unlike
 *  the version it stays a define, and "local" is the honest answer for an unbuilt tree. */
export const InstallationChannel = typeof NOVACLAW_CHANNEL === "string" ? NOVACLAW_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
