#!/usr/bin/env bun
/**
 * Record a release in the rollback manifest.
 *
 *   bun script/release-record.ts ./drop/*.7z ./drop/*.AppImage
 *   bun script/release-record.ts --manifest ./releases.json ./drop/*.7z
 *
 * Last of the four artifact gaps in `doc/release.md`. Digests come from the same `digestOf` the
 * `SHA256SUMS` manifest uses, so the two files cannot disagree about what shipped.
 *
 * ⚠️ Append-only by construction. It REFUSES to re-record a version, because the entry a stuck user
 * needs is exactly the one that is no longer current.
 */
import { statSync } from "node:fs"
import { join } from "node:path"
import { digestOf, parseArgs, splitManifestArg } from "./lib/release-hashes"
import { addRelease, EMPTY, render, type Manifest } from "./lib/release-manifest"

const root = join(import.meta.dir, "..")
const argv = process.argv.slice(2)
const { manifest, rest } = splitManifestArg(argv)
const manifestPath = manifest ?? join(root, "releases.json")
const { inputs } = parseArgs(rest)

if (inputs.length === 0) {
  console.error("usage: bun script/release-record.ts [--manifest <file>] <artifact> [<artifact> ...]")
  process.exit(2)
}
for (const input of inputs) {
  if (!statSync(input, { throwIfNoEntry: false })?.isFile()) {
    console.error(`not a file: ${input}`)
    process.exit(1)
  }
}

const version = ((await Bun.file(join(root, "package.json")).json()) as { version: string }).version
const file = Bun.file(manifestPath)
const current: Manifest = (await file.exists()) ? ((await file.json()) as Manifest) : EMPTY

let next: Manifest
try {
  next = addRelease(current, {
    version,
    released: new Date().toISOString(),
    artifacts: await Promise.all(inputs.map(digestOf)),
  })
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error))
  process.exit(1)
}

await Bun.write(manifestPath, render(next))
const entry = next.releases[0]!
console.log(`recorded ${entry.version} (${entry.artifacts.length} artifacts) -> ${manifestPath}`)
console.log(entry.supersedes ? `  rollback target: ${entry.supersedes}` : "  first recorded release — no rollback target")
