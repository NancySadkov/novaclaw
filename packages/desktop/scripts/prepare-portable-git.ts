#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises"
import path from "node:path"

export const PORTABLE_GIT_VERSION = "2.55.0.5"
export const PORTABLE_GIT_ARCHIVE = `PortableGit-${PORTABLE_GIT_VERSION}-64-bit.7z.exe`
export const PORTABLE_GIT_SHA256 = "5aa8a20f6e9abb2c755f0e73c91c687701a46b309ad84a0ca6509380fa4ae290"

const packageDir = path.resolve(import.meta.dir, "..")
export const PORTABLE_GIT_SUPPLY_ARCHIVE = path.resolve(packageDir, "..", "..", "supply", PORTABLE_GIT_ARCHIVE)
export const PORTABLE_GIT_RESOURCE = path.join(packageDir, "resources", "third-party", "portable-git")
const marker = path.join(PORTABLE_GIT_RESOURCE, ".novaclaw-portable-git.json")
const required = ["bin/bash.exe", "cmd/git.exe", "mingw64/bin/git.exe", "LICENSE.txt"] as const

async function sha256(file: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

async function validateTree(root: string) {
  const missing = (
    await Promise.all(required.map(async (name) => ({ name, found: (await stat(path.join(root, name)).catch(() => undefined))?.isFile() })))
  ).filter((entry) => !entry.found)
  if (missing.length) throw new Error(`PortableGit is incomplete; missing ${missing.map((entry) => entry.name).join(", ")}`)
}

export async function refreshSourceOffer(root: string, offerText: Buffer) {
  const destination = path.join(root, "SOURCE-OFFER.txt")
  const installed = await readFile(destination).catch(() => undefined)
  if (!installed?.equals(offerText)) await Bun.write(destination, offerText)
}

export async function preparePortableGit() {
  if (process.platform !== "win32") return
  const sourceOffer = path.resolve(packageDir, "..", "..", "licenses", "portable-git-NOTICE.md")
  const offerText = await readFile(sourceOffer)
  const prepared = await readFile(marker, "utf8").then(JSON.parse).catch(() => undefined)
  if (prepared?.version === PORTABLE_GIT_VERSION && prepared?.sha256 === PORTABLE_GIT_SHA256) {
    if (await validateTree(PORTABLE_GIT_RESOURCE).then(() => true, () => false)) {
      await refreshSourceOffer(PORTABLE_GIT_RESOURCE, offerText)
      return
    }
  }

  const archive = PORTABLE_GIT_SUPPLY_ARCHIVE
  if (!(await stat(archive).catch(() => undefined))?.isFile())
    throw new Error(`PortableGit archive is missing: ${archive}. Restore the pinned supply with git lfs pull.`)
  const digest = await sha256(archive)
  if (digest !== PORTABLE_GIT_SHA256) throw new Error(`PortableGit SHA-256 mismatch: expected ${PORTABLE_GIT_SHA256}, got ${digest}`)

  const stage = path.join(path.dirname(PORTABLE_GIT_RESOURCE), `.portable-git-stage-${process.pid}`)
  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true })
  try {
    const extract = Bun.spawn([archive, `-o${stage}`, "-y"], {
      stdout: "ignore",
      stderr: "pipe",
      windowsHide: true,
    })
    const stderr = await new Response(extract.stderr).text()
    if ((await extract.exited) !== 0) throw new Error(`PortableGit extraction failed: ${stderr.trim()}`)
    await refreshSourceOffer(stage, offerText)
    await validateTree(stage)
    await Bun.write(path.join(stage, ".novaclaw-portable-git.json"), JSON.stringify({ version: PORTABLE_GIT_VERSION, sha256: PORTABLE_GIT_SHA256 }))
    await rm(PORTABLE_GIT_RESOURCE, { recursive: true, force: true })
    await rename(stage, PORTABLE_GIT_RESOURCE)
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
  console.log(`Prepared embedded PortableGit ${PORTABLE_GIT_VERSION} at ${PORTABLE_GIT_RESOURCE}`)
}

if (import.meta.main) await preparePortableGit()
