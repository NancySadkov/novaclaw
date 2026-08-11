#!/usr/bin/env bun
/**
 * Emit `sbom.cdx.json` for this tree.
 *
 *   bun script/sbom.ts                       # writes ./sbom.cdx.json
 *   bun script/sbom.ts --out ./drop/sbom.json
 *
 * Second of the four artifact gaps in `doc/release.md`. Read the scope note this writes into
 * `metadata.properties` before quoting it as complete: it is the npm tree, not the release.
 */
import { join } from "node:path"
import { componentsFrom, emitSbom, parseLock, type LockEntry } from "./lib/sbom"

const root = join(import.meta.dir, "..")
const out = (() => {
  const i = process.argv.indexOf("--out")
  return i >= 0 ? process.argv[i + 1] : join(root, "sbom.cdx.json")
})()

// bun.lock is JSONC; see `parseLock` for why this is not `Bun.file().json()`.
const lock = parseLock<{
  packages?: Record<string, LockEntry>
}>(await Bun.file(join(root, "bun.lock")).text())
if (!lock.packages || Object.keys(lock.packages).length === 0) {
  console.error("bun.lock has no `packages` block — refusing to emit an SBOM from nothing")
  process.exit(1)
}

const version = ((await Bun.file(join(root, "package.json")).json()) as { version: string }).version
const components = componentsFrom(lock.packages)
await Bun.write(out!, emitSbom({ version, components, timestamp: new Date().toISOString() }))

const withHash = components.filter((c) => c.sha512).length
console.log(`novaclaw ${version} — ${components.length} npm components (${withHash} with sha512) -> ${out}`)
console.log("⚠️  npm tree only: Electron, w64devkit and downloaded binaries are in NOTICE/licenses/.")
