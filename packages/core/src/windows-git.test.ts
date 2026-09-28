import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Git } from "./git"
import { Shell } from "./shell"
import { WindowsGit } from "./windows-git"

const savedGit = process.env.NOVACLAW_PORTABLE_GIT_PATH
const savedKit = process.env.NOVACLAW_W64DEVKIT_PATH
const savedMagick = process.env.NOVACLAW_IMAGEMAGICK_PATH
const savedRipgrep = process.env.NOVACLAW_RIPGREP_PATH
const roots: string[] = []

afterEach(() => {
  if (savedGit === undefined) delete process.env.NOVACLAW_PORTABLE_GIT_PATH
  else process.env.NOVACLAW_PORTABLE_GIT_PATH = savedGit
  if (savedKit === undefined) delete process.env.NOVACLAW_W64DEVKIT_PATH
  else process.env.NOVACLAW_W64DEVKIT_PATH = savedKit
  if (savedMagick === undefined) delete process.env.NOVACLAW_IMAGEMAGICK_PATH
  else process.env.NOVACLAW_IMAGEMAGICK_PATH = savedMagick
  if (savedRipgrep === undefined) delete process.env.NOVACLAW_RIPGREP_PATH
  else process.env.NOVACLAW_RIPGREP_PATH = savedRipgrep
  Git.binary.reset()
  Shell.agentDefault.reset()
  Shell.preferred.reset()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("Windows Git resolves from the packaged tree and precedes host PATH in the agent shell", () => {
  if (process.platform !== "win32") return
  const root = mkdtempSync(path.join(os.tmpdir(), "novaclaw-git-"))
  roots.push(root)
  const gitRoot = path.join(root, "portable-git")
  const kitRoot = path.join(root, "w64devkit")
  const magickRoot = path.join(root, "imagemagick")
  const searchRoot = path.join(root, "ripgrep")
  mkdirSync(path.join(gitRoot, "cmd"), { recursive: true })
  mkdirSync(path.join(gitRoot, "usr", "bin"), { recursive: true })
  mkdirSync(path.join(kitRoot, "bin"), { recursive: true })
  mkdirSync(magickRoot)
  mkdirSync(searchRoot)
  writeFileSync(path.join(magickRoot, "magick.exe"), "stub")
  writeFileSync(path.join(searchRoot, "rg.exe"), "stub")
  writeFileSync(path.join(gitRoot, "cmd", "git.exe"), "stub")
  writeFileSync(path.join(gitRoot, "usr", "bin", "bash.exe"), "stub")
  writeFileSync(path.join(kitRoot, "bin", "sh.exe"), "stub")
  writeFileSync(path.join(kitRoot, "bin", "gcc.exe"), "stub")
  process.env.NOVACLAW_PORTABLE_GIT_PATH = gitRoot
  process.env.NOVACLAW_W64DEVKIT_PATH = kitRoot
  process.env.NOVACLAW_IMAGEMAGICK_PATH = magickRoot
  process.env.NOVACLAW_RIPGREP_PATH = path.join(searchRoot, "rg.exe")
  Git.binary.reset()
  Shell.agentDefault.reset()

  expect(Git.binary()).toBe(path.join(gitRoot, "cmd", "git.exe"))
  expect(Shell.agentDefault()).toBe(path.join(gitRoot, "usr", "bin", "bash.exe"))
  const overlay = Shell.toolchainEnv(path.join(kitRoot, "bin", "sh.exe"), { Path: "C:\\host" })
  expect(overlay?.PATH?.split(path.delimiter)).toEqual([
    path.join(kitRoot, "bin"),
    path.join(gitRoot, "cmd"),
    searchRoot,
    magickRoot,
    "C:\\host",
  ])
  const bashOverlay = Shell.toolchainEnv(path.join(gitRoot, "usr", "bin", "bash.exe"), { Path: "C:\\host" })
  expect(bashOverlay?.PATH?.split(path.delimiter)).toEqual([
    path.join(gitRoot, "mingw64", "bin"),
    path.join(gitRoot, "usr", "bin"),
    path.join(gitRoot, "cmd"),
    path.join(kitRoot, "bin"),
    searchRoot,
    magickRoot,
    "C:\\host",
  ])
})

test("an incomplete packaged Git fails clearly instead of silently using a host installation", () => {
  if (process.platform !== "win32") return
  const root = mkdtempSync(path.join(os.tmpdir(), "novaclaw-git-missing-"))
  roots.push(root)
  process.env.NOVACLAW_PORTABLE_GIT_PATH = root
  Git.binary.reset()
  expect(() => WindowsGit.binary()).toThrow(/embedded Git installation is incomplete/)
  expect(() => Git.binary()).toThrow(/embedded Git installation is incomplete/)
  expect(() => Shell.agentDefault()).toThrow(/embedded Bash installation is incomplete/)
  expect(() => Shell.preferred()).toThrow(/embedded Bash installation is incomplete/)
})
