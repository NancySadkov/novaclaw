import path from "node:path"

import type { Channel } from "./utils"
import { verifyDhtArtifactDirectory, type DhtProbeRunner } from "../../dht/protocol"

/** The missing-sidecar exemption is intentionally tied to the non-publishable development channel. */
export function dhtBuildArguments(channel: Channel): readonly string[] {
  return channel === "dev" ? ["--development"] : []
}

export function dhtArtifactRequired(channel: Channel): boolean {
  return channel !== "dev"
}

/**
 * Verify staging immediately before electron-builder copies it. This protects direct invocations of
 * electron-builder that skipped the lifecycle prebuild; release channels cannot package absence,
 * stale source, a wrong target, or a process that no longer speaks the current JSON-line protocol.
 */
export async function verifyStagedDht(input: {
  readonly channel: Channel
  readonly appRoot: string
  readonly run?: DhtProbeRunner
}): Promise<"absent" | "verified"> {
  return verifyDhtArtifactDirectory(path.join(input.appRoot, "packages", "dht", "build"), {
    required: dhtArtifactRequired(input.channel),
    root: path.join(input.appRoot, "packages", "dht"),
    run: input.run,
  })
}

/** Locate the real resources directory beside an unpacked executable on each release platform. */
export function packagedDhtDirectory(executable: string, platform: NodeJS.Platform = process.platform): string {
  const pathForPlatform = platform === "win32" ? path.win32 : path.posix
  if (platform !== "darwin") return pathForPlatform.join(pathForPlatform.dirname(executable), "resources", "dht")

  let cursor = pathForPlatform.resolve(executable)
  for (;;) {
    if (cursor.toLowerCase().endsWith(".app")) return pathForPlatform.join(cursor, "Contents", "Resources", "dht")
    const parent = pathForPlatform.dirname(cursor)
    if (parent === cursor) throw new Error(`could not find the .app bundle containing ${executable}`)
    cursor = parent
  }
}

/** The post-package half: inspect and execute what was copied, not the prebuild source directory. */
export async function verifyPackagedDht(input: {
  readonly channel: Channel
  readonly executable: string
  readonly appRoot: string
  readonly run?: DhtProbeRunner
}): Promise<"absent" | "verified"> {
  return verifyDhtArtifactDirectory(packagedDhtDirectory(input.executable), {
    required: dhtArtifactRequired(input.channel),
    root: path.join(input.appRoot, "packages", "dht"),
    run: input.run,
  })
}
