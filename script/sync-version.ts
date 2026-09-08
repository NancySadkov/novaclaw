#!/usr/bin/env bun
// Propagates the CANONICAL version — the root package.json `version` — to the two places that
// cannot read it directly:
//
//   1. packages/core/src/installation/version.gen.ts — the runtime constant every consumer imports.
//      Generated rather than a build-time define, because a define is absent under `bun test` and in
//      any bundle whose builder forgot it (that is how the sidecar came to report "local").
//   2. packages/desktop/package.json — electron-builder REQUIRES a literal version in the app's own
//      package.json (artifact naming + the metadata baked into the packaged app), so this one copy
//      is unavoidable. It is machine-written here and guarded by version-single-source.test.ts.
//
// Every other workspace package.json deliberately has NO version field: they are private, never
// published (we don't use the npm registry), and nothing reads them — so they cannot drift.
//
// Writes preserve each file's existing line endings; several files in this tree are CRLF and a
// wholesale rewrite would bury a one-line change in an 800-line diff.
import path from "path"

const root = path.resolve(import.meta.dir, "..")
const rootPkgPath = path.join(root, "package.json")

const version = (await Bun.file(rootPkgPath).json()).version
if (typeof version !== "string" || version.length === 0)
  throw new Error(`the root package.json has no "version" — it is the single source of truth`)

/** Rewrites `file` with `next`, matching the line endings already in it. */
const write = async (file: string, next: string) => {
  const before = await Bun.file(file)
    .text()
    .catch(() => "")
  const crlf = before.includes("\r\n")
  const body = crlf ? next.replaceAll("\n", "\r\n") : next
  if (body === before) return false
  await Bun.write(file, body)
  return true
}

const generated = `// GENERATED — do not edit. Run \`bun run version:sync\` from the repo root after changing the
// canonical version in the root package.json. \`version-single-source.test.ts\` fails if this drifts.
export const VERSION = "${version}"
`

const genPath = path.join(root, "packages", "core", "src", "installation", "version.gen.ts")
const genChanged = await write(genPath, generated)

// Surgical replace, NOT a JSON round-trip: reserializing would reorder/reformat the whole file.
const desktopPath = path.join(root, "packages", "desktop", "package.json")
const desktopBefore = await Bun.file(desktopPath).text()
const versionField = /("version"\s*:\s*)"[^"]*"/
if (!versionField.test(desktopBefore))
  throw new Error(`${desktopPath} has no "version" field — electron-builder requires one`)
const desktopChanged = await write(
  desktopPath,
  desktopBefore.replaceAll("\r\n", "\n").replace(versionField, `$1"${version}"`),
)

console.log(`version ${version}`)
console.log(`  ${genChanged ? "updated" : "unchanged"}  packages/core/src/installation/version.gen.ts`)
console.log(`  ${desktopChanged ? "updated" : "unchanged"}  packages/desktop/package.json`)
