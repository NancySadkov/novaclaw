#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises"
import path from "node:path"

export const MINGIT_VERSION = "2.55.0.5"
export const MINGIT_ARCHIVE = `MinGit-${MINGIT_VERSION}-64-bit.zip`
export const MINGIT_SHA256 = "56d7b226b7693196cfc71fef26568f536c4a021ab6c37ff2db4287bed908e96e"

const packageDir = path.resolve(import.meta.dir, "..")
export const MINGIT_SUPPLY_ARCHIVE = path.resolve(packageDir, "..", "..", "supply", MINGIT_ARCHIVE)
export const PORTABLE_GIT_RESOURCE = path.join(packageDir, "resources", "third-party", "portable-git")
const resourceParent = path.join(packageDir, "resources", "third-party")
const marker = path.join(PORTABLE_GIT_RESOURCE, ".novaclaw-portable-git.json")
const required = ["usr/bin/bash.exe", "usr/bin/sh.exe", "usr/bin/ssh.exe", "cmd/git.exe", "mingw64/bin/git.exe", "LICENSE.txt"] as const

async function sha256(file: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

async function validateTree(root: string) {
  const missing = (
    await Promise.all(required.map(async (name) => ({ name, found: (await stat(path.join(root, name)).catch(() => undefined))?.isFile() })))
  ).filter((entry) => !entry.found)
  if (missing.length) throw new Error(`Embedded Git is incomplete; missing ${missing.map((entry) => entry.name).join(", ")}`)
}

export async function refreshSourceOffer(root: string, offerText: Buffer) {
  const destination = path.join(root, "SOURCE-OFFER.txt")
  const installed = await readFile(destination).catch(() => undefined)
  if (!installed?.equals(offerText)) await Bun.write(destination, offerText)
}

function requireResourcePath(target: string) {
  const relative = path.relative(resourceParent, path.resolve(target))
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error(`Refusing to replace Git resources outside ${resourceParent}: ${target}`)
}

export async function preparePortableGit() {
  if (process.platform !== "win32") return
  const sourceOffer = path.resolve(packageDir, "..", "..", "licenses", "mingit-NOTICE.md")
  const offerText = await readFile(sourceOffer)
  const prepared = await readFile(marker, "utf8").then(JSON.parse).catch(() => undefined)
  if (prepared?.version === MINGIT_VERSION && prepared?.sha256 === MINGIT_SHA256 && prepared?.layout === "bash-from-sh") {
    if (await validateTree(PORTABLE_GIT_RESOURCE).then(() => true, () => false)) {
      await refreshSourceOffer(PORTABLE_GIT_RESOURCE, offerText)
      return
    }
  }

  const archive = MINGIT_SUPPLY_ARCHIVE
  if (!(await stat(archive).catch(() => undefined))?.isFile())
    throw new Error(`MinGit archive is missing: ${archive}. Restore the pinned supply with git lfs pull.`)
  const digest = await sha256(archive)
  if (digest !== MINGIT_SHA256) throw new Error(`MinGit SHA-256 mismatch: expected ${MINGIT_SHA256}, got ${digest}`)

  const stage = path.join(path.dirname(PORTABLE_GIT_RESOURCE), `.portable-git-stage-${process.pid}`)
  requireResourcePath(stage)
  requireResourcePath(PORTABLE_GIT_RESOURCE)
  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true })
  try {
    const unzip = path.join(packageDir, "resources", "third-party", "w64devkit", "bin", "busybox.exe")
    if (!(await stat(unzip).catch(() => undefined))?.isFile())
      throw new Error(`w64devkit must be prepared before MinGit: ${unzip}`)
    const extract = Bun.spawn([unzip, "unzip", "-q", archive, "-d", stage], {
      stdout: "ignore",
      stderr: "pipe",
      windowsHide: true,
    })
    const stderr = await new Response(extract.stderr).text()
    if ((await extract.exited) !== 0) throw new Error(`MinGit extraction failed: ${stderr.trim()}`)
    await copyFile(path.join(stage, "usr", "bin", "sh.exe"), path.join(stage, "usr", "bin", "bash.exe"))
    await refreshSourceOffer(stage, offerText)
    await validateTree(stage)
    await Bun.write(path.join(stage, ".novaclaw-portable-git.json"), JSON.stringify({ version: MINGIT_VERSION, sha256: MINGIT_SHA256, layout: "bash-from-sh" }))
    await rm(PORTABLE_GIT_RESOURCE, { recursive: true, force: true })
    await rename(stage, PORTABLE_GIT_RESOURCE)
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
  console.log(`Prepared embedded MinGit ${MINGIT_VERSION} with Bash at ${PORTABLE_GIT_RESOURCE}`)
}

if (import.meta.main) await preparePortableGit()
