#!/usr/bin/env bun
// SHIP IMAGEMAGICK (owner, 2026-08-23: *"please ensure we ship imagemagick and anything required for
// the model to quickly edit images, like setting pixels, drawing basic geometric primitives and
// converting between image formats"*).
//
// 🔴 **Vision is half a capability without a way to WRITE an image.** A colleague can already look
// at a screenshot; until now it could not produce one, crop one, or turn a PNG into a WebP, so every
// image task ended in "I can see it, but I cannot change it". `magick` closes that with one binary,
// and it is the right one to embed: a single static executable, no installer, no registry, no DLL
// search path to go wrong on a stranger's machine.
//
// ⚠️ **Only `magick.exe` is shipped, and that is a 217 MB decision.** The portable archive contains
// EIGHT executables — `compare`, `composite`, `conjure`, `identify`, `magick`, `mogrify`, `montage`,
// `stream` — and they are byte-identical 31 MB copies of the same static binary, dispatching on
// argv[0]. In ImageMagick 7 every one of them is reachable as `magick <verb>`, so shipping the other
// seven costs 217 MB of duplication for nothing. Measured on the 7.1.2-29 x64 portable build:
// 240 MB extracted, 31 MB kept.
//
// ⚠️ **The XML files are not optional.** `magick` reads `configure.xml`, `delegates.xml`,
// `policy.xml`, `type.xml`, `colors.xml` and friends from beside itself; without them it starts but
// loses colour-name lookup, format delegates and the security policy — the last of which is the file
// that decides what an agent's `magick` invocation is allowed to touch.
//
// Mirrors `prepare-w64devkit.ts` deliberately: same repository supply cabinet, same SHA-256 pin,
// same idempotent marker, same "a supplied archive that fails verification is an error, not an
// update or re-download".

import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { cp, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import { resolveSevenZipArchiver } from "../../../script/lib/build-tools"

export const IMAGEMAGICK_VERSION = "7.1.2-29"
export const IMAGEMAGICK_ARCHIVE = `ImageMagick-${IMAGEMAGICK_VERSION}-portable-Q16-x64.7z`
export const IMAGEMAGICK_SHA256 = "4715072c158c46bbdc3e6971817e92ed43fca7c93142cad142ee42c603baaac1"

const packageDir = path.resolve(import.meta.dir, "..")
export const IMAGEMAGICK_SUPPLY_ARCHIVE = path.resolve(packageDir, "..", "..", "supply", IMAGEMAGICK_ARCHIVE)
export function resolveImageMagickArchive(override: string | undefined) {
  return override ? path.resolve(override) : IMAGEMAGICK_SUPPLY_ARCHIVE
}
export const IMAGEMAGICK_RESOURCE = path.join(packageDir, "resources", "third-party", "imagemagick")
const marker = path.join(IMAGEMAGICK_RESOURCE, ".novaclaw-imagemagick.json")

/** What is kept out of the 240 MB the archive expands to. Everything else is the seven duplicates. */
// ⚠️ `.md` is NOT kept. Upstream's `ChangeLog.md` is 848 KB nothing reads, and it carries a U+0016
// that the repo's invisible-character ledger correctly flags — a control character in somebody
// else's changelog is neither our defect nor ours to fix, and the licence requires the file we DO
// keep (`LICENSE.txt`) to travel verbatim. Dropping the changelog costs nothing and removes the
// conflict at its source; `third-party` is excluded from that ledger as well, for the files that
// genuinely must ship.
const KEEP_FILE = /\.(xml|icc|txt)$/i
const KEEP_EXE = new Set(["magick.exe"])

const required = ["magick.exe", "configure.xml", "delegates.xml", "policy.xml", "type.xml", "LICENSE.txt"] as const

export async function prepareImageMagick() {
  // Windows only for now: POSIX hosts get `magick` from their package manager, and `shell.ts` looks
  // for a system one there. Embedding a Linux build remains a separate packaging concern.
  if (process.platform !== "win32") return
  if (await validResource()) return

  const archive = resolveImageMagickArchive(process.env["NOVACLAW_IMAGEMAGICK_ARCHIVE"])
  await mkdir(path.dirname(archive), { recursive: true })
  await ensureArchive(archive, IMAGEMAGICK_SHA256)

  const stage = path.join(path.dirname(IMAGEMAGICK_RESOURCE), `.imagemagick-stage-${process.pid}`)
  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true })

  // ⚠️ The asset is a bare `.7z`, not a self-extractor like w64devkit's, so it needs a reader.
  // `resolveSevenZipArchiver` is the one that PROBES for libarchive rather than trusting whichever
  // `tar.exe` PATH answers with — the lottery that killed the 0.1.66 release.
  const archiver = resolveSevenZipArchiver(path.resolve(packageDir, "..", ".."))
  const extract = Bun.spawn([archiver.path, "-xf", archive, "-C", stage], {
    stdout: "ignore",
    stderr: "pipe",
    windowsHide: true,
  })
  const stderr = await new Response(extract.stderr).text()
  const code = await extract.exited
  if (code !== 0) throw new Error(`${archiver.path} exited ${code} extracting ImageMagick: ${stderr.trim()}`)

  // The archive is flat, but a future one may not be — find the directory that holds `magick.exe`.
  const root = (await stat(path.join(stage, "magick.exe")).catch(() => undefined))?.isFile()
    ? stage
    : await findRoot(stage)
  if (!root) throw new Error(`ImageMagick archive did not contain magick.exe`)

  const build = path.join(stage, ".kept")
  await mkdir(build, { recursive: true })
  let kept = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const name = entry.name
    const wanted = KEEP_EXE.has(name.toLowerCase()) || (KEEP_FILE.test(name) && !name.toLowerCase().endsWith(".exe"))
    if (!wanted) continue
    await cp(path.join(root, name), path.join(build, name))
    kept += 1
  }
  await validateTree(build)
  await Bun.write(
    marker.replace(IMAGEMAGICK_RESOURCE, build),
    JSON.stringify({ version: IMAGEMAGICK_VERSION, archive: IMAGEMAGICK_ARCHIVE, sha256: IMAGEMAGICK_SHA256 }, null, 2),
  )
  await rm(IMAGEMAGICK_RESOURCE, { recursive: true, force: true })
  await mkdir(path.dirname(IMAGEMAGICK_RESOURCE), { recursive: true })
  await rename(build, IMAGEMAGICK_RESOURCE)
  await rm(stage, { recursive: true, force: true })
  console.log(`Prepared embedded ImageMagick ${IMAGEMAGICK_VERSION} (${kept} files) at ${IMAGEMAGICK_RESOURCE}`)
}

async function findRoot(dir: string): Promise<string | undefined> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(dir, entry.name)
    if ((await stat(path.join(candidate, "magick.exe")).catch(() => undefined))?.isFile()) return candidate
  }
  return undefined
}

async function validResource() {
  const value = await readFile(marker, "utf8")
    .then(JSON.parse)
    .catch(() => undefined)
  if (value?.version !== IMAGEMAGICK_VERSION || value?.sha256 !== IMAGEMAGICK_SHA256) return false
  return validateTree(IMAGEMAGICK_RESOURCE).then(
    () => true,
    () => false,
  )
}

async function validateTree(root: string) {
  const missing = (
    await Promise.all(
      required.map(async (name) => ({
        name,
        found: (await stat(path.join(root, name)).catch(() => undefined))?.isFile(),
      })),
    )
  ).filter((item) => !item.found)
  if (missing.length)
    throw new Error(`ImageMagick is incomplete; missing ${missing.map((item) => item.name).join(", ")}`)
}

async function ensureArchive(file: string, expected: string) {
  const digest = await sha256(file)
  if (digest === expected) return
  if (digest === undefined)
    throw new Error(
      `ImageMagick archive is not available locally: ${file}. Restore supply with git lfs pull, or set NOVACLAW_IMAGEMAGICK_ARCHIVE to a verified override.`,
    )
  throw new Error(`ImageMagick SHA-256 mismatch: expected ${expected}, got ${digest}`)
}

async function sha256(file: string) {
  if (!(await stat(file).catch(() => undefined))?.isFile()) return
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

if (import.meta.main) {
  await prepareImageMagick()
}
