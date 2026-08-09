import { describe, expect, test } from "bun:test"
import { ShellApproval } from "@novaclaw/core/tool/shell-approval"

describe("shell approval reduction", () => {
  test("splits POSIX chains without splitting quoted separators", () => {
    expect(ShellApproval.analyze(`printf 'a && b' && git status | wc -l & notify`, "/bin/bash")).toEqual({
      status: "parsed",
      segments: [`printf 'a && b'`, "git status", "wc -l", "notify"],
    })
  })

  test("splits PowerShell and cmd with their own escape rules", () => {
    expect(ShellApproval.analyze('Write-Output "a;b"; Remove-Item x', "pwsh.exe")).toEqual({
      status: "parsed",
      segments: ['Write-Output "a;b"', "Remove-Item x"],
    })
    expect(ShellApproval.analyze("echo a ^& b && del x", "cmd.exe")).toEqual({
      status: "parsed",
      segments: ["echo a ^& b", "del x"],
    })
  })

  test.each(["echo $(whoami)", "echo `whoami`", "echo hi > existing.txt", "echo 'unterminated"])(
    "fails ambiguous syntax closed: %s",
    (command) => expect(ShellApproval.analyze(command, "/bin/bash").status).toBe("unparseable"),
  )

  test("fails an unknown shell closed", () => {
    expect(ShellApproval.analyze("safe && dangerous", "fish")).toEqual({
      status: "unparseable",
      reason: "unrecognised-shell",
    })
  })
})
