import path from "node:path"

// The channel resolver lives in ONE place (`@novaclaw/script/channel`) and is re-exported here so the
// existing `./utils` import sites (copy-icons, copy-metainfo, prebuild) keep working. The local copy
// this replaces silently fell back to "dev" on an unrecognised value and did not understand the
// "latest" alias, so it disagreed with electron.vite.config.ts about what `latest` means.
export { resolveChannel } from "@novaclaw/script/channel"
export type { Channel } from "@novaclaw/script/channel"

/** The canonical version — the root package.json, the single source of truth. Read from disk rather
 *  than imported from @novaclaw/core so these build scripts need no dependency on the kernel. */
export async function canonicalVersion(): Promise<string> {
  const rootPkg = path.resolve(import.meta.dir, "../../../package.json")
  const version = (await Bun.file(rootPkg).json()).version
  if (typeof version !== "string" || version.length === 0)
    throw new Error(`the root package.json has no "version" — it is the single source of truth`)
  return version
}
