import { describe, expect, test } from "bun:test"
import path from "path"
import { Shell } from "@novaclaw/core/shell"
import { FSUtil } from "@novaclaw/core/fs-util"
import { which } from "@novaclaw/core/util/which"

const withShell = async (shell: string | undefined, fn: () => void | Promise<void>) => {
  const prev = process.env.SHELL
  if (shell === undefined) delete process.env.SHELL
  else process.env.SHELL = shell
  Shell.acceptable.reset()
  Shell.preferred.reset()
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev
    Shell.acceptable.reset()
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

  test("detects posix shells", () => {
    expect(Shell.posix("/bin/bash")).toBe(true)
    expect(Shell.posix("/bin/fish")).toBe(false)
    expect(Shell.posix("C:/tools/pwsh.exe")).toBe(false)
  })

  test("falls back when configured shell cannot be resolved", async () => {
    await withShell(undefined, async () => {
      const preferred = Shell.preferred()
      const acceptable = Shell.acceptable()
      expect(Shell.preferred("novaclaw-missing-shell")).toBe(preferred)
      expect(Shell.acceptable("novaclaw-missing-shell")).toBe(acceptable)
    })
  })

  test("falls back for terminal-only acceptable shells", () => {
    expect(Shell.name(Shell.acceptable("fish"))).not.toBe("fish")
    expect(Shell.name(Shell.acceptable("nu"))).not.toBe("nu")
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
    test("rejects blacklisted shells case-insensitively", async () => {
      await withShell("NU.EXE", async () => {
        expect(Shell.name(Shell.acceptable())).not.toBe("nu")
      })
    })

    test("normalizes Git Bash shell paths from env", async () => {
      // preferred() resolves + stats the shell, so use the REAL installed git bash (skip if
      // none) rather than a hardcoded path: set its cygwin form as SHELL, expect it normalized.
      const bash = Shell.gitbash()
      if (!bash) return
      const win = FSUtil.windowsPath(bash)
      const cygwin = win.replace(/^([A-Za-z]):/, (_m, drive) => `/cygdrive/${drive.toLowerCase()}`)
      await withShell(cygwin, async () => {
        expect(Shell.preferred()).toBe(win)
      })
    })

    test("resolves /usr/bin/bash from env to Git Bash", async () => {
      const bash = Shell.gitbash()
      if (!bash) return
      await withShell("/usr/bin/bash", async () => {
        expect(Shell.acceptable()).toBe(bash)
        expect(Shell.preferred()).toBe(bash)
      })
    })

    test("resolves bare bash to Git Bash before PATH", async () => {
      const bash = Shell.gitbash()
      if (!bash) return
      expect(Shell.acceptable("bash")).toBe(bash)
      expect(Shell.preferred("bash")).toBe(bash)
      await withShell("bash", async () => {
        expect(Shell.acceptable()).toBe(bash)
        expect(Shell.preferred()).toBe(bash)
      })
    })

    test("resolves bare PowerShell shells", async () => {
      const shell = which("pwsh") || which("powershell")
      if (!shell) return
      await withShell(path.win32.basename(shell), async () => {
        expect(Shell.preferred()).toBe(shell)
      })
    })

    // ⚠️ The regression this guards (measured 2026-07-26): git resolved through
    // `<root>\mingw64\bin\git.exe`, the old fixed `<git>/../../bin/bash.exe` guess missed, and the
    // AGENT shell silently became cmd.exe while every prompt and recipe promised bash. The detector
    // now walks up from the resolved git binary, so any of git-for-windows' PATH entries works.
    test("git-bash detection survives EVERY git-for-windows PATH layout", () => {
      const git = which("git")
      if (!git) return
      const bash = Shell.gitbash()
      // On a machine with git, SOME bash must be found — bundled, or the system install's.
      expect(bash).toBeDefined()
      expect(Shell.name(bash!)).toBe("bash")
    })

    test("an agent shell that is not bash is reported, never silent", () => {
      const isBash = Shell.agentShellIsBash()
      expect(isBash).toBe(Shell.name(Shell.agentDefault()) === "bash")
      // The note exists exactly when the fallback fired — that is what the system prompt appends so
      // the model stops writing POSIX at a shell that cannot run it.
      const note = Shell.bashFallbackNote()
      if (isBash) expect(note).toBeUndefined()
      else expect(note).toContain(Shell.agentDefault())
    })
  }
})
