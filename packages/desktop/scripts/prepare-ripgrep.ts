#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { copyFile, mkdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { RipgrepBinary } from "../../core/src/ripgrep/binary"

const packageDir = path.resolve(import.meta.dir, "..")
export const RIPGREP_RESOURCE = path.join(packageDir, "resources", "third-party", "ripgrep", "rg.exe")

export async function prepareRipgrep() {
  if (process.platform !== "win32") return
  const source = process.env.NOVACLAW_RIPGREP_BINARY ?? Bun.which("rg.exe")
  if (!source) throw new Error("ripgrep is required to build NovaClaw; install rg or set NOVACLAW_RIPGREP_BINARY")
  const expected = RipgrepBinary.CHECKSUM[RipgrepBinary.VERSION]["x64-win32"].executable
  const bytes = await readFile(source)
  const actual = createHash("sha256").update(bytes).digest("hex")
  if (actual !== expected)
    throw new Error(`ripgrep ${RipgrepBinary.VERSION} SHA-256 mismatch: expected ${expected}, got ${actual}`)
  if ((await stat(RIPGREP_RESOURCE).catch(() => undefined))?.isFile()) {
    const current = createHash("sha256").update(await readFile(RIPGREP_RESOURCE)).digest("hex")
    if (current === expected) return
  }
  await mkdir(path.dirname(RIPGREP_RESOURCE), { recursive: true })
  await copyFile(source, RIPGREP_RESOURCE)
}

if (import.meta.main) await prepareRipgrep()
