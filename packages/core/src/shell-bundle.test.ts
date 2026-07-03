import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ShellBundle } from "./shell-bundle"
import { Shell } from "./shell"

// Each test builds its own fake bundle tree and points NOVACLAW_SHELL_BUNDLE_ROOT at it —
// no Global.Path writes, no network, no real extraction.
const cleanups: string[] = []
async function tmpdir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  cleanups.push(dir)
  return dir
}

const savedRoot = process.env.NOVACLAW_SHELL_BUNDLE_ROOT
afterEach(async () => {
  if (savedRoot === undefined) delete process.env.NOVACLAW_SHELL_BUNDLE_ROOT
  else process.env.NOVACLAW_SHELL_BUNDLE_ROOT = savedRoot
  ShellBundle.resolve.reset()
  Shell.agentDefault.reset()
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true })
})

async function fakeBundle(withManifest = true) {
  const root = path.join(await tmpdir("shell-bundle-"), "portable-git")
  await fs.mkdir(path.join(root, "bin"), { recursive: true })
  await fs.mkdir(path.join(root, "cmd"), { recursive: true })
  await fs.mkdir(path.join(root, "usr", "bin"), { recursive: true })
  await fs.mkdir(path.join(root, "mingw64", "bin"), { recursive: true })
  await fs.writeFile(path.join(root, "bin", "bash.exe"), "fake")
  await fs.writeFile(path.join(root, "cmd", "git.exe"), "fake")
  if (withManifest)
    await fs.writeFile(
      path.join(root, "bundle.json"),
      JSON.stringify({ kind: "portable-git", version: "2.55.0.2", url: "x", sha256: "y", provisionedAt: 123 }),
    )
  return root
}

describe("shell bundle resolution", () => {
  test("resolves a provisioned bundle (bash + git + manifest version)", async () => {
    const root = await fakeBundle()
    process.env.NOVACLAW_SHELL_BUNDLE_ROOT = root
    ShellBundle.resolve.reset()
    const resolved = ShellBundle.resolve()
    expect(resolved).toBeDefined()
    expect(resolved!.bash).toBe(path.join(root, "bin", "bash.exe"))
    expect(resolved!.git).toBe(path.join(root, "cmd", "git.exe"))
    expect(resolved!.version).toBe("2.55.0.2")
  })

  test("does not resolve a half-extracted bundle (missing git)", async () => {
    const root = await fakeBundle()
    await fs.rm(path.join(root, "cmd", "git.exe"))
    process.env.NOVACLAW_SHELL_BUNDLE_ROOT = root
    ShellBundle.resolve.reset()
    expect(ShellBundle.resolve()).toBeUndefined()
  })

  test("missing manifest still resolves (manual installs), just without a version", async () => {
    const root = await fakeBundle(false)
    process.env.NOVACLAW_SHELL_BUNDLE_ROOT = root
    ShellBundle.resolve.reset()
    const resolved = ShellBundle.resolve()
    expect(resolved).toBeDefined()
    expect(resolved!.version).toBeUndefined()
  })
})

describe("msys path prepend", () => {
  test("derives the MSYS root from <root>/bin/bash.exe and lists existing dirs first", async () => {
    const root = await fakeBundle()
    const bash = path.join(root, "bin", "bash.exe")
    expect(ShellBundle.msysRoot(bash)).toBe(root)
    const prepend = ShellBundle.pathPrepend(bash)
    expect(prepend).toContain(path.join(root, "mingw64", "bin"))
    expect(prepend).toContain(path.join(root, "usr", "bin"))
    expect(prepend).toContain(path.join(root, "cmd"))
    expect(prepend).toContain(path.join(root, "bin"))
  })

  test("derives the root from <root>/usr/bin/bash.exe too", async () => {
    const root = await fakeBundle()
    expect(ShellBundle.msysRoot(path.join(root, "usr", "bin", "bash.exe"))).toBe(root)
  })

  test("returns nothing for a non-MSYS layout (bare 'bash')", () => {
    expect(ShellBundle.pathPrepend("bash")).toEqual([])
  })

  test("envForBash keys PATH with the base env's casing and prepends the userland", async () => {
    const root = await fakeBundle()
    const bash = path.join(root, "bin", "bash.exe")
    const env = ShellBundle.envForBash(bash, { Path: "C:\\Windows" })
    expect(env).toBeDefined()
    const value = env!["Path"]
    expect(value).toBeDefined()
    expect(value!.startsWith(path.join(root, "mingw64", "bin"))).toBe(true)
    expect(value!.endsWith("C:\\Windows")).toBe(true)
  })
})

describe("shell bundle provisioning", () => {
  test("fails closed in offline mode without touching the network", async () => {
    const configDir = await tmpdir("shell-bundle-config-")
    let fetched = false
    const fetchImpl = (async () => {
      fetched = true
      throw new Error("must not fetch")
    }) as unknown as typeof fetch
    expect(
      ShellBundle.provision({
        platform: "win32",
        configDir,
        env: { NOVACLAW_OFFLINE: "1" },
        fetchImpl,
      }),
    ).rejects.toThrow(/provision-before-airgap/)
    expect(fetched).toBe(false)
  })

  test("rejects a sha256 mismatch and removes the artifact", async () => {
    const configDir = await tmpdir("shell-bundle-config-")
    const dir = await tmpdir("shell-bundle-target-")
    process.env.NOVACLAW_SHELL_BUNDLE_ROOT = path.join(dir, "portable-git")
    ShellBundle.resolve.reset()
    const body = new Response("not the real artifact").body!
    const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch
    expect(
      ShellBundle.provision({
        platform: "win32",
        configDir,
        env: {},
        fetchImpl,
        url: ShellBundle.DEFAULT_URL,
      }),
    ).rejects.toThrow(/sha256 mismatch/)
    const leftovers = await fs.readdir(dir).catch(() => [])
    expect(leftovers).not.toContain("portable-git-download.7z.exe")
  })

  test("provisions end-to-end with an injected extractor and writes the manifest", async () => {
    const configDir = await tmpdir("shell-bundle-config-")
    const dir = await tmpdir("shell-bundle-target-")
    const root = path.join(dir, "portable-git")
    process.env.NOVACLAW_SHELL_BUNDLE_ROOT = root
    ShellBundle.resolve.reset()
    const payload = "fake artifact bytes"
    const { createHash } = await import("node:crypto")
    const digest = createHash("sha256").update(payload).digest("hex")
    const fetchImpl = (async () => new Response(payload, { status: 200 })) as unknown as typeof fetch
    const extract = async (_artifact: string, dest: string) => {
      await fs.mkdir(path.join(dest, "bin"), { recursive: true })
      await fs.mkdir(path.join(dest, "cmd"), { recursive: true })
      await fs.writeFile(path.join(dest, "bin", "bash.exe"), "fake")
      await fs.writeFile(path.join(dest, "cmd", "git.exe"), "fake")
    }
    const resolved = await ShellBundle.provision({
      platform: "win32",
      configDir,
      env: {},
      fetchImpl,
      extract,
      url: ShellBundle.DEFAULT_URL,
      sha256: digest,
    })
    expect(resolved.bash).toBe(path.join(root, "bin", "bash.exe"))
    expect(resolved.version).toBe(ShellBundle.DEFAULT_VERSION)
    const manifest = JSON.parse(await fs.readFile(path.join(root, "bundle.json"), "utf8"))
    expect(manifest.kind).toBe("portable-git")
    expect(manifest.sha256).toBe(digest)
  })

  test("refuses to provision on POSIX", () => {
    expect(ShellBundle.provision({ platform: "linux" })).rejects.toThrow(/Windows-only/)
  })
})

describe("agent default shell (B11)", () => {
  test("prefers the bundled bash on win32", async () => {
    if (process.platform !== "win32") return
    const root = await fakeBundle()
    process.env.NOVACLAW_SHELL_BUNDLE_ROOT = root
    ShellBundle.resolve.reset()
    Shell.agentDefault.reset()
    expect(Shell.agentDefault()).toBe(path.join(root, "bin", "bash.exe"))
    expect(Shell.gitbash()).toBe(path.join(root, "bin", "bash.exe"))
  })

  test("agentDefault is bash-or-fallback everywhere", () => {
    Shell.agentDefault.reset()
    const value = Shell.agentDefault()
    expect(typeof value).toBe("string")
    expect(value.length).toBeGreaterThan(0)
  })
})
