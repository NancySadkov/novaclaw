import { describe, expect, test } from "bun:test"
import path from "path"
import { Shell } from "@novaclaw/core/shell"
import { which } from "@novaclaw/core/util/which"

const withShell = async (shell: string | undefined, fn: () => void | Promise<void>) => {
  const prev = process.env.SHELL
  if (shell === undefined) delete process.env.SHELL
  else process.env.SHELL = shell
  Shell.preferred.reset()
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev
    Shell.preferred.reset()
  }
}

describe("shell", () => {
  test("normalizes shell names", () => {
    expect(Shell.name("/bin/bash")).toBe("bash")
    if (process.platform === "win32") {
      expect(Shell.name("C:/tools/NU.EXE")).toBe("nu")
      expect(Shell.name("C:/tools/PWSH.EXE")).toBe("pwsh")
    }
  })

  test("detects login shells", () => {
    expect(Shell.login("/bin/bash")).toBe(true)
    expect(Shell.login("C:/tools/pwsh.exe")).toBe(false)
  })

  test("agentPlatform reports the environment the agent's own shell reports, and caches it", () => {
    // The prompt's environment line must agree with what the model sees when IT runs `uname` — see
    // `Shell.agentPlatform` for the Windows/NT vs MSYS mismatch this exists to prevent.
    Shell.agentPlatform.reset()
    const first = Shell.agentPlatform()
    for (const [field, value] of Object.entries(first))
      expect(value.length, `${field} must not be empty`).toBeGreaterThan(0)
    // Cached: reading it must not spawn a shell on a prompt that regenerates per turn.
    expect(Shell.agentPlatform()).toBe(first)
  })

  test("detects posix shells", () => {
    expect(Shell.posix("/bin/bash")).toBe(true)
    expect(Shell.posix("/bin/fish")).toBe(false)
    expect(Shell.posix("C:/tools/pwsh.exe")).toBe(false)
  })

  test("falls back when the environment shell cannot be resolved", async () => {
    await withShell(undefined, async () => {
      const preferred = Shell.preferred()
      await withShell("novaclaw-missing-shell", () => expect(Shell.preferred()).toBe(preferred))
    })
  })

  test("builds command args per shell family", () => {
    expect(Shell.args("/bin/sh", "echo hi", "/tmp")).toEqual(["-c", "echo hi"])
    expect(Shell.args("/usr/bin/fish", "echo hi", "/tmp")).toEqual(["-c", "echo hi"])
    const zsh = Shell.args("/bin/zsh", "echo hi", "/tmp")
    expect(zsh[0]).toBe("-l")
    expect(zsh[1]).toBe("-c")
    expect(zsh.at(-1)).toBe("/tmp")
  })

  if (process.platform === "win32") {
    test("resolves bare PowerShell shells", async () => {
      const shell = which("pwsh") || which("powershell")
      if (!shell) return
      await withShell(path.win32.basename(shell), async () => {
        expect(Shell.preferred()).toBe(shell)
      })
    })

    test("the supplied agent shell uses embedded Bash when the distribution is present", () => {
      const bundled = process.env.NOVACLAW_PORTABLE_GIT_PATH
      if (bundled) expect(Shell.agentDefault()).toBe(path.join(bundled, "bin", "bash.exe"))
    })
  }
})
