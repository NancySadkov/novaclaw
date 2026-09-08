import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  candidateDirs,
  resolveSevenZipArchiver,
  resolveTool,
  shippedW64devkitBin,
  ToolNotFoundError,
  type Runner,
} from "./build-tools"

const REPO = "C:\\repo"
const ENV = { SystemRoot: "C:\\Windows", W64DEVKIT_HOME: "C:\\kit" } as NodeJS.ProcessEnv

describe("candidate order", () => {
  test("🔴 the SHIPPED w64devkit is first and Windows is last", () => {
    // The whole point of the owner's rule. What we ship is pinned, hashed and smoke-tested; what a
    // developer happens to have installed is not, and `C:\Windows` is the last resort.
    const dirs = candidateDirs(REPO, ENV)
    expect(dirs[0]).toBe(shippedW64devkitBin(REPO))
    expect(dirs[1]).toBe(path.join("C:\\kit", "bin"))
    expect(dirs.at(-1)).toBe(path.join("C:\\Windows", "System32"))
  })

  test("🔴 PATH is never a candidate", () => {
    // The 0.1.66 release died because a bare `tar.exe` resolved by PATH to Git for Windows' GNU tar.
    // If this list ever grows a `PATH` entry, that failure comes straight back.
    const dirs = candidateDirs(REPO, { ...ENV, PATH: "C:\\soft\\Git\\usr\\bin" } as NodeJS.ProcessEnv)
    expect(dirs.some((dir) => dir.includes("Git"))).toBe(false)
  })

  test("a machine with no SystemRoot and no local kit still offers the shipped one", () => {
    expect(candidateDirs(REPO, {} as NodeJS.ProcessEnv)).toEqual([
      shippedW64devkitBin(REPO),
      "C:\\soft\\w64devkit\\bin",
    ])
  })
})

describe("resolution is by PROBE, not by assumption", () => {
  const busybox: Runner = () => ({ status: 0, output: "tar (busybox) 1.38.0" })
  const bsdtar: Runner = () => ({ status: 0, output: "bsdtar 3.7.2 - libarchive 3.7.2" })

  test("🔴 a present-but-WRONG binary is rejected, not used", () => {
    // The previous fix pinned an absolute path by REASONING about which binary lives there, and
    // reasoning is what was wrong the first time. Presence is not capability.
    const resolved = resolveTool({
      name: "tar.exe",
      repoRoot: REPO,
      env: ENV,
      probe: { args: ["--version"], expect: /bsdtar|libarchive/i },
      exists: () => true,
      run: (file) => (file.includes("Windows") ? bsdtar(file, []) : busybox(file, [])),
    })
    expect(resolved.path).toBe(path.join("C:\\Windows", "System32", "tar.exe"))
    expect(resolved.considered[0]!.ok).toBe(false)
    expect(resolved.considered[0]!.why).toContain("did not match")
  })

  test("the preferred candidate wins when it CAN do the job", () => {
    const resolved = resolveTool({
      name: "gzip.exe",
      repoRoot: REPO,
      env: ENV,
      probe: { args: ["--version"] },
      exists: (file) => file.startsWith(shippedW64devkitBin(REPO)),
      run: () => ({ status: 0, output: "gzip 1.13" }),
    })
    expect(resolved.path).toBe(path.join(shippedW64devkitBin(REPO), "gzip.exe"))
  })

  test("a non-zero probe exit is a rejection", () => {
    expect(() =>
      resolveTool({
        name: "tar.exe",
        repoRoot: REPO,
        env: ENV,
        probe: { args: ["--version"] },
        exists: () => true,
        run: () => ({ status: 1, output: "" }),
      }),
    ).toThrow(ToolNotFoundError)
  })

  test("a probe that THROWS is a rejection, not a crash", () => {
    expect(() =>
      resolveTool({
        name: "tar.exe",
        repoRoot: REPO,
        env: ENV,
        probe: { args: ["--version"] },
        exists: () => true,
        run: () => {
          throw new Error("EACCES")
        },
      }),
    ).toThrow(/probe threw/)
  })

  test("⚠️ the failure NAMES every candidate and why each was refused", () => {
    // A build that stops must say what it looked at. "tar not found" sends the next person to PATH,
    // which is the one place this module refuses to look.
    try {
      resolveTool({
        name: "tar.exe",
        repoRoot: REPO,
        env: ENV,
        probe: { args: ["--version"], expect: /bsdtar/ },
        exists: (file) => !file.includes("kit"),
        run: () => ({ status: 0, output: "tar (busybox)" }),
      })
      throw new Error("expected a throw")
    } catch (error) {
      const message = String(error)
      expect(message).toContain(shippedW64devkitBin(REPO))
      expect(message).toContain("C:\\Windows")
      expect(message).toContain("not present")
      expect(message).toContain("PATH is deliberately not searched")
    }
  })
})

describe("the 7z archiver, on THIS machine", () => {
  test("resolves to a real libarchive tar by absolute path", () => {
    if (process.platform !== "win32") return
    const repoRoot = path.resolve(import.meta.dir, "..", "..")
    const resolved = resolveSevenZipArchiver(repoRoot)
    expect(path.isAbsolute(resolved.path)).toBe(true)
    // ⚠️ Asserting the SHAPE, not a fixed path: which candidate wins is a property of the machine,
    // and pinning one here would make this test a restatement of the implementation.
    expect(resolved.considered.find((item) => item.ok)?.path).toBe(resolved.path)
  })

  test("⚠️ the shipped w64devkit tar is busybox, and is EXPECTED to fail this probe", () => {
    // Recorded as a test rather than only as a comment: if a future w64devkit ships libarchive tar,
    // this flips and the preference order silently starts using the kit — which is the outcome the
    // owner asked for, and we should notice it happening rather than assume it never will.
    if (process.platform !== "win32") return
    const repoRoot = path.resolve(import.meta.dir, "..", "..")
    const resolved = resolveSevenZipArchiver(repoRoot)
    const shipped = resolved.considered.find((item) => item.path.startsWith(shippedW64devkitBin(repoRoot)))
    if (!shipped) return // the kit is not laid down in this checkout
    expect(shipped.ok).toBe(false)
  })
})
