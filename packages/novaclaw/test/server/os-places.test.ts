import { describe, expect, test } from "bun:test"
import { dedupePlaces, parseGtkBookmarks, parseXdgUserDirs } from "@/server/os-places"

// The picker's Places rail parsers (pure halves of probePlaces — existence checks live in the
// probe). XDG: ~/.config/user-dirs.dirs; GTK: ~/.config/gtk-3.0/bookmarks.

describe("parseXdgUserDirs", () => {
  test("resolves $HOME entries and skips the disabled ($HOME-only) convention", () => {
    const text = [
      "# comment",
      'XDG_DESKTOP_DIR="$HOME/Desktop"',
      'XDG_DOWNLOAD_DIR="$HOME/dl"',
      'XDG_MUSIC_DIR="$HOME"',
      'not a dir line',
    ].join("\n")
    expect(parseXdgUserDirs(text, "/home/nancy")).toEqual([
      { name: "Desktop", path: "/home/nancy/Desktop" },
      { name: "Download", path: "/home/nancy/dl" },
    ])
  })
})

describe("parseGtkBookmarks", () => {
  test("parses file URIs with optional labels and percent-encoding", () => {
    const text = [
      "file:///home/nancy/projects",
      "file:///home/nancy/my%20docs Work Docs",
      "sftp://remote/ignored",
      "",
    ].join("\n")
    expect(parseGtkBookmarks(text)).toEqual([
      { name: "projects", path: "/home/nancy/projects" },
      { name: "Work Docs", path: "/home/nancy/my docs" },
    ])
  })
})

describe("dedupePlaces", () => {
  test("keeps first occurrence, case-insensitive on win32", () => {
    const places = [
      { name: "Documents", path: "C:\\Users\\n\\Documents" },
      { name: "docs", path: "c:\\users\\n\\documents" },
      { name: "Downloads", path: "C:\\Users\\n\\Downloads" },
    ]
    expect(dedupePlaces(places, "win32").map((p) => p.name)).toEqual(["Documents", "Downloads"])
    expect(dedupePlaces(places, "linux")).toHaveLength(3)
  })
})
