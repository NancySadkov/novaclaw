import { describe, expect, test } from "bun:test"
import { shellName, terminalTargetLine } from "./terminal-target"

// terminal.md's product contract: "A BusyBox shell is not Bash; the UI and diagnostics must name it
// honestly... Do not label `ash`, PowerShell, or `cmd.exe` as Bash." That is a claim about rendered
// text, so it gets a test rather than a comment — nothing else in the tree can catch a future
// "friendly name" mapping that quietly calls the embedded shell Bash because it is POSIX-ish.

describe("the shell is named by what it IS", () => {
  test("the embedded BusyBox shell is never called Bash", () => {
    const line = terminalTargetLine({
      server: "localhost:4096",
      shell: "C:\\Program Files\\NovaClaw\\resources\\third-party\\w64devkit\\bin\\sh.exe",
      cwd: "C:\\Users\\nangl",
    })
    expect(line).toContain("sh")
    expect(line.toLowerCase()).not.toContain("bash")
  })

  test("PowerShell and cmd keep their own names", () => {
    expect(shellName("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe("powershell")
    expect(shellName("C:\\Windows\\System32\\cmd.exe")).toBe("cmd")
  })

  test("a real bash IS called bash", () => {
    // The negative control for the assertion above: a rule that only ever hides the word would pass
    // by never printing it at all.
    expect(shellName("C:\\Users\\n\\.local\\share\\novaclaw\\shell\\portable-git\\bin\\bash.exe")).toBe("bash")
    expect(shellName("/usr/bin/bash")).toBe("bash")
  })

  test("both separators are handled, because the SERVER's platform decides the shape", () => {
    expect(shellName("/bin/zsh")).toBe("zsh")
    expect(shellName("C:/msys64/usr/bin/fish.exe")).toBe("fish")
  })
})

describe("the target line degrades instead of rendering blanks", () => {
  test("a tab persisted before shell/cwd existed still shows the instance", () => {
    expect(terminalTargetLine({ server: "localhost:4096" })).toBe("localhost:4096")
  })

  test("partial information keeps its separators tidy", () => {
    expect(terminalTargetLine({ server: "spark", cwd: "/home/nancy" })).toBe("spark · /home/nancy")
    expect(terminalTargetLine({ server: "spark", shell: "/bin/sh" })).toBe("spark · sh")
  })

  test("everything present reads target · folder · shell", () => {
    expect(terminalTargetLine({ server: "spark:4096", cwd: "/home/nancy", shell: "/bin/ash" })).toBe(
      "spark:4096 · /home/nancy · ash",
    )
  })

  test("an empty command is not rendered as an empty segment", () => {
    expect(shellName("")).toBeUndefined()
    expect(terminalTargetLine({ server: "s", shell: "", cwd: "" })).toBe("s")
  })
})
