#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises"
import path from "node:path"

export const W64DEVKIT_VERSION = "2.9.0"
export const W64DEVKIT_ARCHIVE = `w64devkit-x64-${W64DEVKIT_VERSION}.7z.exe`
export const W64DEVKIT_SHA256 = "bff1d13fc2718eebd93548cf37f8d0332d925458d5e99506cff8f46eb5a9de5a"
export const W64DEVKIT_SOURCE_ARCHIVE = "source.tar"
export const W64DEVKIT_SOURCE_SHA256 = "170941e1239faf2affd1b70be827cbe93de07943236719e12b287a43c2a73eec"

const packageDir = path.resolve(import.meta.dir, "..")
const supplyDir = path.resolve(packageDir, "..", "..", "supply")
export const W64DEVKIT_SUPPLY_ARCHIVE = path.join(supplyDir, W64DEVKIT_ARCHIVE)
export const W64DEVKIT_SUPPLY_SOURCE = path.resolve(supplyDir, `w64devkit-${W64DEVKIT_VERSION}-source.tar`)
export function resolveW64devkitArchive(override: string | undefined) {
  return override ? path.resolve(override) : W64DEVKIT_SUPPLY_ARCHIVE
}
export function resolveW64devkitSupplySource(override: string | undefined) {
  return override ? path.resolve(override) : W64DEVKIT_SUPPLY_SOURCE
}
export const W64DEVKIT_RESOURCE = path.join(packageDir, "resources", "third-party", "w64devkit")
const marker = path.join(W64DEVKIT_RESOURCE, ".novaclaw-w64devkit.json")
const required = [
  "VERSION.txt",
  "README.md",
  "COPYING.MinGW-w64-runtime.txt",
  "bin/sh.exe",
  "bin/busybox.exe",
  "bin/gcc.exe",
  "bin/as.exe",
  "bin/ld.exe",
  "bin/make.exe",
] as const

export async function prepareW64devkit() {
  if (process.platform !== "win32") return
  if (await validResource()) return

  const archive = resolveW64devkitArchive(process.env.NOVACLAW_W64DEVKIT_ARCHIVE)
  await mkdir(path.dirname(archive), { recursive: true })
  await ensureArchive(archive, W64DEVKIT_SHA256, "NOVACLAW_W64DEVKIT_ARCHIVE")

  const stage = path.join(path.dirname(W64DEVKIT_RESOURCE), `.w64devkit-stage-${process.pid}`)
  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true })
  const extract = Bun.spawn([archive, `-o${stage}`, "-y"], { stdout: "ignore", stderr: "pipe", windowsHide: true })
  const stderr = await new Response(extract.stderr).text()
  const code = await extract.exited
  if (code !== 0) throw new Error(`w64devkit extractor exited ${code}: ${stderr.trim()}`)

  const extracted = path.join(stage, "w64devkit")
  await validateTree(extracted)
  await Bun.write(
    path.join(extracted, ".novaclaw-w64devkit.json"),
    JSON.stringify({ version: W64DEVKIT_VERSION, archive: W64DEVKIT_ARCHIVE, sha256: W64DEVKIT_SHA256 }, null, 2),
  )
  await rm(W64DEVKIT_RESOURCE, { recursive: true, force: true })
  await mkdir(path.dirname(W64DEVKIT_RESOURCE), { recursive: true })
  await rename(extracted, W64DEVKIT_RESOURCE)
  await rm(stage, { recursive: true, force: true })
  console.log(`Prepared embedded w64devkit ${W64DEVKIT_VERSION} at ${W64DEVKIT_RESOURCE}`)
}

async function validResource() {
  const value = await readFile(marker, "utf8")
    .then(JSON.parse)
    .catch(() => undefined)
  if (value?.version !== W64DEVKIT_VERSION || value?.sha256 !== W64DEVKIT_SHA256) return false
  return validateTree(W64DEVKIT_RESOURCE).then(
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
  if (missing.length) throw new Error(`w64devkit is incomplete; missing ${missing.map((item) => item.name).join(", ")}`)
  const version = (await readFile(path.join(root, "VERSION.txt"), "utf8")).trim()
  if (version !== W64DEVKIT_VERSION)
    throw new Error(`w64devkit version mismatch: expected ${W64DEVKIT_VERSION}, got ${version}`)
}

export async function prepareW64devkitSource(file: string) {
  await mkdir(path.dirname(file), { recursive: true })
  // Release inputs belong in the repository's durable supply cabinet, never in tmp/ or dist/:
  // both are deliberately disposable. The environment variable remains a useful explicit override
  // for reproducing a build with a separately staged archive.
  const source = resolveW64devkitSupplySource(process.env.NOVACLAW_W64DEVKIT_SOURCE_ARCHIVE)
  await ensureArchive(source, W64DEVKIT_SOURCE_SHA256, "NOVACLAW_W64DEVKIT_SOURCE_ARCHIVE")
  if (source !== file) await copyFile(source, file)
  await ensureArchive(file, W64DEVKIT_SOURCE_SHA256, "NOVACLAW_W64DEVKIT_SOURCE_ARCHIVE")
}

async function ensureArchive(file: string, expected: string, variable: string) {
  const digest = await sha256(file)
  if (digest === expected) return
  if (digest === undefined)
    throw new Error(
      `w64devkit archive is not available locally: ${file}. Restore supply with git lfs pull, or set ${variable} to a verified override.`,
    )
  throw new Error(`w64devkit SHA-256 mismatch: expected ${expected}, got ${digest}`)
}

async function sha256(file: string) {
  if (!(await stat(file).catch(() => undefined))?.isFile()) return
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

if (import.meta.main) {
  const source = process.argv.indexOf("--source")
  if (source !== -1) {
    const output = process.argv[source + 1]
    if (!output) throw new Error("--source requires an output path")
    await prepareW64devkitSource(path.resolve(output))
  } else {
    await prepareW64devkit()
  }
}
