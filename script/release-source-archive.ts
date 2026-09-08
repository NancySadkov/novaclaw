#!/usr/bin/env bun
// Rewrite `git archive`'s tar into the published `.7z` source drop — with the archiver RESOLVED and
// PROBED rather than named.
//
// 🔴 This step is where cutting 0.1.66 died, at the LAST command of the release, on
// `tar: unrecognized option '--options'`. A bare `tar.exe` resolves by `PATH`, and on a box with Git
// for Windows installed that is GNU tar rather than the libarchive bsdtar the script assumed. The
// app archive had already been produced, so it read as an archiving bug rather than as the wrong
// binary — three minutes of confusion for a one-word cause.
//
// Owner, 2026-08-23: the build must use the w64devkit we SHIP, not `C:\Windows` and not Git's. That
// preference is `script/lib/build-tools.ts`, and it is a preference with a PROBE behind it: the
// shipped kit is tried first and rejected on measured grounds (its `tar` is busybox, which cannot
// write 7z at all) rather than skipped on a hunch.
//
// A batch file cannot express any of that, which is why this moved out of the release wrapper
// — the same move `doc/release.md` records for the hash manifest, and for the same reason: the
// tested one should be the only one.

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { resolveSevenZipArchiver } from "./lib/build-tools"

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const [tarFile, outFile] = process.argv.slice(2)
if (!tarFile || !outFile) fail("usage: release-source-archive.ts <source.tar> <source.7z>")
if (!fs.existsSync(tarFile)) fail(`input tar does not exist: ${tarFile}`)
// Refused rather than overwritten: a stale 7z beside a fresh tar is how a release publishes source
// that does not match its binary, and that is the exact failure the dirty-tree check above it
// exists to prevent.
if (fs.existsSync(outFile)) fail(`output already exists, refusing to overwrite: ${outFile}`)

const repoRoot = path.resolve(import.meta.dir, "..")
const archiver = resolveSevenZipArchiver(repoRoot)
console.log(`archiver: ${archiver.path}`)
for (const item of archiver.considered) console.log(`  ${item.ok ? "ok  " : "no  "} ${item.path} — ${item.why}`)

const result = spawnSync(
  archiver.path,
  ["-a", "-c", "--options", "7zip:compression=lzma2", "-f", outFile, `@${tarFile}`],
  { encoding: "utf8", windowsHide: true },
)
if (result.status !== 0) {
  fail(`${archiver.path} exited ${result.status ?? "null"}\n${result.stdout ?? ""}${result.stderr ?? ""}`)
}
// ⚠️ The exit code is not the whole answer — an archiver can exit 0 having written nothing readable.
const size = fs.statSync(outFile, { throwIfNoEntry: false })?.size ?? 0
if (size === 0) fail(`${outFile} is empty after archiving; refusing to publish it`)
console.log(`wrote ${outFile} (${size} bytes)`)
fs.rmSync(tarFile, { force: true })
