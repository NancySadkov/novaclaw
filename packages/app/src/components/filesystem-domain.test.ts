import { describe, expect, test } from "bun:test"
import {
  filesystemEntryNameError,
  filesystemJoin,
  filesystemName,
  filesystemParent,
  filesystemShortcut,
} from "./filesystem-domain"

describe("filesystem domain", () => {
  test("splits Windows, POSIX, drive-root, and UNC paths", () => {
    expect(filesystemName("C:\\work\\src")).toBe("src")
    expect(filesystemParent("C:\\work\\src")).toBe("C:/work")
    expect(filesystemParent("C:\\work")).toBe("C:/")
    expect(filesystemParent("C:\\")).toBeUndefined()
    expect(filesystemParent("/work/src")).toBe("/work")
    expect(filesystemParent("//server/share")).toBeUndefined()
    expect(filesystemParent("//server/share/folder")).toBe("//server/share")
    expect(filesystemJoin("C:\\work", "new")).toBe("C:/work/new")
  })

  test("rejects empty, traversal, and multi-segment names", () => {
    expect(filesystemEntryNameError("   ")).toBe("empty")
    expect(filesystemEntryNameError("..")).toBe("reserved")
    expect(filesystemEntryNameError("child/name")).toBe("separator")
    expect(filesystemEntryNameError("child\\name")).toBe("separator")
    expect(filesystemEntryNameError("child name")).toBeUndefined()
  })

  test("maps standard manager shortcuts but ignores text editing", () => {
    expect(filesystemShortcut({ key: "Delete" })).toBe("delete")
    expect(filesystemShortcut({ key: "F2" })).toBe("rename")
    expect(filesystemShortcut({ key: "N", ctrlKey: true, shiftKey: true })).toBe("new-folder")
    expect(filesystemShortcut({ key: "Delete", editable: true })).toBeUndefined()
    expect(filesystemShortcut({ key: "n", ctrlKey: true })).toBeUndefined()
  })
})
