#!/usr/bin/env bun
/**
 * Write `SHA256SUMS` for a release drop.
 *
 *   bun script/release-hashes.ts <artifact> [<artifact> ...]
 *   bun script/release-hashes.ts --out ./drop/SHA256SUMS ./drop/*.7z ./drop/*.dmg
 *
 * Closes the first of the four artifact gaps in `doc/release.md`. The manifest is coreutils-format,
 * so `sha256sum -c SHA256SUMS` works unmodified for the person downloading a 1.15 GB archive — which
 * is the only audience it has, and the reason the format is not ours to invent.
 *
 * ⚠️ Prints each digest with its size. A drop where one artifact is suspiciously small is the case
 * a manifest cannot catch on its own: the hash of a truncated file is a perfectly good hash.
 */
import { statSync } from "node:fs"
import { dirname, join } from "node:path"
import { digestOf, parseArgs, renderManifest } from "./lib/release-hashes"

const { out, inputs } = parseArgs(process.argv.slice(2))

if (inputs.length === 0) {
  console.error("usage: bun script/release-hashes.ts [--out <file>] <artifact> [<artifact> ...]")
  process.exit(2)
}

for (const input of inputs) {
  // Fail on a missing input rather than skipping it: a manifest that silently omits the artifact you
  // meant to publish is worse than no manifest, because it looks complete.
  if (!statSync(input, { throwIfNoEntry: false })?.isFile()) {
    console.error(`not a file: ${input}`)
    process.exit(1)
  }
}

const digests = await Promise.all(inputs.map(digestOf))
const manifest = renderManifest(digests)
const target = out ?? join(dirname(inputs[0]!), "SHA256SUMS")
await Bun.write(target, manifest)

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
for (const d of [...digests].sort((a, b) => (a.name < b.name ? -1 : 1)))
  console.log(`  ${d.sha256.slice(0, 16)}…  ${mb(d.bytes).padStart(10)}  ${d.name}`)
console.log(`\n${digests.length} artifact(s) -> ${target}`)
console.log(`verify with:  sha256sum -c ${target}`)
