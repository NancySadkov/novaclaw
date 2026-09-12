import { describe, expect, test } from "bun:test"
import { absoluteDisplayPath, fileMutationDisplayPaths } from "./tool-file-path"

describe("expanded file-tool paths", () => {
  test("resolves relative targets against the remote host working directory", () => {
    expect(absoluteDisplayPath("C:\\Users\\Ada\\scratch", "drafts/browser-printing-wedge.md")).toBe(
      "C:\\Users\\Ada\\scratch\\drafts\\browser-printing-wedge.md",
    )
    expect(absoluteDisplayPath("/home/ada/project", "./src/../README.md")).toBe("/home/ada/project/README.md")
  })

  test("keeps already-absolute Windows, UNC, and POSIX targets absolute", () => {
    expect(absoluteDisplayPath("/ignored", "D:/work/file.ts")).toBe("D:\\work\\file.ts")
    expect(absoluteDisplayPath("/ignored", "\\\\server\\share\\file.ts")).toBe("\\\\server\\share\\file.ts")
    expect(absoluteDisplayPath("C:\\ignored", "/srv/work/file.ts")).toBe("/srv/work/file.ts")
  })

  test("covers text writes, binary writes, and every file in a patch", () => {
    expect(
      fileMutationDisplayPaths({
        name: "write",
        args: { path: "notes/new.md" },
        directory: "/work",
      }),
    ).toEqual(["/work/notes/new.md"])
    expect(
      fileMutationDisplayPaths({
        name: "write-hex",
        args: { filename: "assets/icon.png" },
        directory: "C:\\work",
      }),
    ).toEqual(["C:\\work\\assets\\icon.png"])
    expect(
      fileMutationDisplayPaths({
        name: "apply_patch",
        args: { patchText: "*** Add File: src/a.ts\n*** Update File: src/b.ts" },
        result: {
          applied: [
            { resource: "src/a.ts", target: "/work/src/a.ts" },
            { resource: "src/b.ts", target: "/work/src/b.ts" },
          ],
        },
        directory: "/work",
      }),
    ).toEqual(["/work/src/a.ts", "/work/src/b.ts"])
  })
})
