import { describe, expect, test } from "bun:test"
import { ServeChildCommand } from "./serve-child-command"

describe("ServeChildCommand", () => {
  test("does not replay a relative Bun cwd after the supervisor already entered it", () => {
    expect(
      ServeChildCommand.make({
        execPath: "C:/tools/bun.exe",
        execArgv: ["--conditions=browser", "--cwd", "packages/novaclaw"],
        argv: ["C:/tools/bun.exe", "C:/repo/packages/novaclaw/src/index.ts", "serve", "--port", "4096"],
      }),
    ).toEqual([
      "C:/tools/bun.exe",
      "--conditions=browser",
      "C:/repo/packages/novaclaw/src/index.ts",
      "serve",
      "--port",
      "4096",
      "--no-supervise",
    ])
  })

  test("does not replay runtime flags already baked into a compiled executable", () => {
    expect(
      ServeChildCommand.make({
        execPath: "/opt/novaclaw",
        execArgv: ["--user-agent=novaclaw/0.1.0", "--use-system-ca", "--"],
        // Bun single-file builds expose their embedded virtual entry as argv[1].
        argv: ["bun", "B:/~BUN/root/index.js", "serve", "--port", "4096"],
      }),
    ).toEqual(["/opt/novaclaw", "serve", "--port", "4096", "--no-supervise"])
  })

  test("recognizes Bun's current Linux bunfs virtual entry", () => {
    expect(
      ServeChildCommand.make({
        execPath: "/opt/novaclaw",
        execArgv: ["--user-agent=novaclaw/0.1.5", "--use-system-ca", "--"],
        argv: ["bun", "/$bunfs/root/novaclaw", "serve", "--port", "4096"],
      }),
    ).toEqual(["/opt/novaclaw", "serve", "--port", "4096", "--no-supervise"])
  })

  test("drops the attached cwd spelling too", () => {
    expect(
      ServeChildCommand.make({
        execPath: "bun",
        execArgv: ["--cwd=packages/novaclaw", "--conditions=browser"],
        argv: ["bun", "src/index.ts", "serve"],
      }),
    ).toEqual(["bun", "--conditions=browser", "src/index.ts", "serve", "--no-supervise"])
  })
})
