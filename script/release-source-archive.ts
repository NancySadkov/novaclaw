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
import { auditSourceListing } from "./lib/source-audit"

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

// Read back what was just written, with the SAME binary that wrote it.
//
// ⚠️ This used to be `tar -tf "%ARCHIVE%"` in the batch file, which failed twice over: `tar` resolved
// by PATH to Git for Windows' GNU tar, and GNU tar reads the `C:` of an absolute Windows path as a
// remote-host specification — `tar: Cannot connect to C: resolve failed`. The archive on disk was
// fine; the tool trying to LOOK at it was the wrong tool. Resolving the archiver once and using it
// for both directions is what keeps the writer and the reader from ever disagreeing.
const listed = spawnSync(archiver.path, ["-tf", outFile], { encoding: "utf8", windowsHide: true })
// A refused drop is DELETED, not reported-and-kept. Measured, not assumed: the first version of this
// check printed its verdict and exited 1 with the offending archive still sitting in
// packages/desktop/dist, which is the one location a person reaches for without reading the log —
// and the whole reason the wrapper refuses a dirty tree is that a source drop must not be able to
// disagree with the commit it names.
// Narrowed once and named, because a hoisted `function` declaration does not inherit the argv guard
// above it: the compiler reads its body as able to run before that check, and says so.
const archivePath: string = outFile
function refuse(message: string): never {
  fs.rmSync(archivePath, { force: true })
  fail(`${message}\n(refused archive deleted: ${archivePath})`)
}
if (listed.status !== 0) {
  refuse(
    `${archiver.path} could not list the archive it just wrote (exit ${listed.status ?? "null"}):\n${listed.stdout ?? ""}${listed.stderr ?? ""}`,
  )
}
const audit = auditSourceListing(listed.stdout ?? "", path.basename(outFile, ".7z"))
if (!audit.ok) refuse(`the source drop is not releasable:\n${audit.problems.map((p) => `  - ${p}`).join("\n")}`)
console.log(`audited ${audit.entries} entries: obligations present, no node_modules, no .git`)

fs.rmSync(tarFile, { force: true })
