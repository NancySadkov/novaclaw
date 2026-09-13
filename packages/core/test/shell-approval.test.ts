import { describe, expect, test } from "bun:test"
import { ShellApproval } from "@novaclaw/core/tool/shell-approval"

describe("shell approval reduction", () => {
  test("maps MSYS drive roots only for a Windows POSIX shell", () => {
    expect(ShellApproval.hostPath("/c/Users/nangl/My Project/out.txt", "C:/w64devkit/bin/sh.exe", "win32")).toBe(
      "C:/Users/nangl/My Project/out.txt",
    )
    expect(ShellApproval.hostPath("/D/tmp", "C:/Program Files/Git/bin/bash.exe", "win32")).toBe("D:/tmp")
    expect(ShellApproval.hostPath("/c/tmp", "pwsh.exe", "win32")).toBe("/c/tmp")
    expect(ShellApproval.hostPath("/c/tmp", "/bin/bash", "linux")).toBe("/c/tmp")
    expect(ShellApproval.hostPath("C:/tmp", "C:/w64devkit/bin/sh.exe", "win32")).toBe("C:/tmp")
  })
  test("splits POSIX chains without splitting quoted separators", () => {
    expect(ShellApproval.analyze(`printf 'a && b' && git status | wc -l & notify`, "/bin/bash")).toEqual({
      status: "parsed",
      segments: [`printf 'a && b'`, "git status", "wc -l", "notify"],
      redirects: [],
      background: true,
    })
  })

  test("recognizes a trailing POSIX background operator without mistaking redirects or quotes for one", () => {
    expect(ShellApproval.analyze("serve >/dev/null 2>&1 &", "/bin/bash")).toEqual({
      status: "parsed",
      segments: ["serve >/dev/null 2>&1"],
      redirects: [],
      background: true,
    })
    expect(ShellApproval.analyze(`printf '%s' '&' 2>&1`, "/bin/bash")).toEqual({
      status: "parsed",
      segments: [`printf '%s' '&' 2>&1`],
      redirects: [],
    })
  })

  test("splits PowerShell and cmd with their own escape rules", () => {
    expect(ShellApproval.analyze('Write-Output "a;b"; Remove-Item x', "pwsh.exe")).toEqual({
      status: "parsed",
      segments: ['Write-Output "a;b"', "Remove-Item x"],
      redirects: [],
    })
    expect(ShellApproval.analyze("echo a ^& b && del x", "cmd.exe")).toEqual({
      status: "parsed",
      segments: ["echo a ^& b", "del x"],
      redirects: [],
    })
  })

  test("attributes nested substitutions and output redirects", () => {
    expect(ShellApproval.analyze("echo $(git status && rm -rf build) > 'result file.txt'", "/bin/bash")).toEqual({
      status: "parsed",
      segments: ["echo $(git status && rm -rf build) > 'result file.txt'", "git status", "rm -rf build"],
      redirects: [{ target: "result file.txt", append: false }],
    })
    expect(ShellApproval.analyze("echo `whoami` &>> trace.log", "/bin/bash")).toEqual({
      status: "parsed",
      segments: ["echo `whoami` &>> trace.log", "whoami"],
      redirects: [{ target: "trace.log", append: true }],
    })
  })

  test("terminates at EOF after spaced arithmetic substitutions", () => {
    const command =
      'SCR="/c/tmp/raw"; NF=10328; NC=12; t0=$(date +%s); for i in $(seq 0 $((NC-1))); do f=$(( i*NF/NC )); t=$(((i+1)*NF/NC)); ./comms.exe --from $f --to $t --raw > "$SCR/part_$(printf %02d $i).raw" & if [ $((i % 6)) -eq 5 ]; then wait; fi; done; wait; echo "elapsed $(( $(date +%s) - t0 ))s"'
    const started = performance.now()
    expect(ShellApproval.analyze(command, "/bin/bash")).toEqual({
      status: "unparseable",
      reason: "dynamic-redirect-target",
    })
    expect(performance.now() - started).toBeLessThan(100)
  })

  test("attributes tee, dd, and PowerShell content writers", () => {
    expect(ShellApproval.analyze("make | tee -a 'build log.txt'; dd if=in.bin of=out.bin", "/bin/bash")).toEqual({
      status: "parsed",
      segments: ["make", "tee -a 'build log.txt'", "dd if=in.bin of=out.bin"],
      redirects: [
        { target: "build log.txt", append: true },
        { target: "out.bin", append: false },
      ],
    })
    expect(ShellApproval.analyze("Get-Date | Out-File -FilePath result.txt", "pwsh")).toEqual({
      status: "parsed",
      segments: ["Get-Date", "Out-File -FilePath result.txt"],
      redirects: [{ target: "result.txt", append: false }],
    })
  })

  test("ignores shell-native output sinks and descriptor duplication", () => {
    expect(ShellApproval.analyze("probe 2>/dev/null >&2", "/bin/bash")).toMatchObject({
      status: "parsed",
      redirects: [],
    })
    expect(ShellApproval.analyze("Write-Output hi > $null", "pwsh")).toMatchObject({
      status: "parsed",
      redirects: [],
    })
    expect(ShellApproval.analyze("echo hi > NUL", "cmd.exe")).toMatchObject({
      status: "parsed",
      redirects: [],
    })
  })

  test.each(["echo hi > $TARGET", "cat <<EOF", "echo 'unterminated"])("fails ambiguous syntax closed: %s", (command) =>
    expect(ShellApproval.analyze(command, "/bin/bash").status).toBe("unparseable"),
  )

  test("fails an unknown shell closed", () => {
    expect(ShellApproval.analyze("safe && dangerous", "fish")).toEqual({
      status: "unparseable",
      reason: "unrecognised-shell",
    })
  })
})
