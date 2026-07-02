import { describe, expect, test } from "bun:test"
import { toModelOutput } from "./trash"

// The tool's execute path is LocationMutation + PermissionV2 plumbing over the store (which has its
// own suite in ../trash.test.ts); the model-facing rendering is the pure piece worth pinning here.
describe("trash tool toModelOutput", () => {
  test("file entry renders the restore id", () => {
    expect(toModelOutput({ id: "2026-07-02/1751470000000-doc.txt", originalPath: "C:/w/doc.txt", type: "file" })).toBe(
      "Moved file to trash (restorable ~2 days): 2026-07-02/1751470000000-doc.txt",
    )
  })

  test("directory entry names the type", () => {
    expect(toModelOutput({ id: "2026-07-02/1751470000000-proj", originalPath: "C:/w/proj", type: "directory" })).toBe(
      "Moved directory to trash (restorable ~2 days): 2026-07-02/1751470000000-proj",
    )
  })
})
