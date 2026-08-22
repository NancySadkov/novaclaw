import { describe, expect, test } from "bun:test"
import { fileDownloadHref, fileUrl, hostFile, resolveAgentFile } from "./agent-file-link"
import { setInstanceBase } from "./instance-origin"

// Which hrefs the chat treats as FILES ON THIS MACHINE, and which it leaves alone.
//
// 🔴 The safe direction is `undefined`: a link the chat ignores still works as an ordinary link,
// while a web URL wrongly treated as a file breaks one that worked. Every "not a host file" case
// below is therefore as load-bearing as the positive ones.

describe("what counts as a file on this machine", () => {
  test("a Windows path, in either slash", () => {
    expect(hostFile(String.raw`C:\data\scratch\theron\chart.svg`)).toEqual({
      directory: "C:/data/scratch/theron",
      name: "chart.svg",
      image: true,
    })
    expect(hostFile("C:/data/scratch/theron/notes.md")).toEqual({
      directory: "C:/data/scratch/theron",
      name: "notes.md",
      image: false,
    })
  })

  test("a POSIX path", () => {
    expect(hostFile("/home/nancy/report.pdf")).toEqual({
      directory: "/home/nancy",
      name: "report.pdf",
      image: false,
    })
  })

  test("a file:// URL, which is how a model most often writes one", () => {
    expect(hostFile("file:///C:/data/out.png")).toEqual({ directory: "C:/data", name: "out.png", image: true })
    // Percent-encoding survives the round trip — a folder with a space is ordinary.
    expect(hostFile("file:///home/nancy/my%20notes/plan.md")).toEqual({
      directory: "/home/nancy/my notes",
      name: "plan.md",
      image: false,
    })
  })

  test("images are decided by EXTENSION, case-insensitively", () => {
    expect(hostFile("/tmp/a.PNG")?.image).toBe(true)
    expect(hostFile("/tmp/a.svg")?.image).toBe(true)
    expect(hostFile("/tmp/a.txt")?.image).toBe(false)
    // No extension at all is a download, never a broken <img>.
    expect(hostFile("/tmp/LICENSE")?.image).toBe(false)
  })

  test("a query or fragment is not part of the name", () => {
    // A model writing `chart.svg#legend` means the file; asking the server for that name 404s.
    expect(hostFile("/tmp/chart.svg#legend")).toEqual({ directory: "/tmp", name: "chart.svg", image: true })
  })

  test("🔴 web and non-file schemes are LEFT ALONE", () => {
    for (const href of [
      "https://novaclaw.app/docs",
      "http://127.0.0.1:4096/",
      "mailto:nancy\example.com",
      "#section",
      "./relative.md",
      "docs/guide.md",
      "",
      undefined,
    ])
      expect({ href, file: hostFile(href) }).toEqual({ href, file: undefined })
  })

  test("a bare root or a directory is not a file", () => {
    expect(hostFile("/")).toBeUndefined()
    expect(hostFile("/tmp/")).toBeUndefined()
  })
})

describe("the URL that serves it", () => {
  test("both halves are encoded", () => {
    const url = fileUrl("http://127.0.0.1:4096", {
      directory: "C:/my data/scratch",
      name: "a chart.svg",
      image: true,
    })
    // ⚠️ Unencoded, the drive colon truncates the query and the space breaks the segment.
    expect(url).toBe("http://127.0.0.1:4096/api/fs/read/a%20chart.svg?location%5Bdirectory%5D=C%3A%2Fmy%20data%2Fscratch")
  })

  test("a trailing slash on the base does not double up", () => {
    expect(fileUrl("http://x/", { directory: "/tmp", name: "a.txt", image: false })).toContain("http://x/api/fs/read/")
  })
})

describe("the resolver the renderer is handed", () => {
  test("a host image resolves to a same-origin URL and says it is an image", () => {
    expect(resolveAgentFile("/tmp/chart.svg")).toEqual({
      url: "/api/fs/read/chart.svg?location%5Bdirectory%5D=%2Ftmp",
      image: true,
    })
  })

  test("a host file resolves, and is NOT an image", () => {
    expect(resolveAgentFile("/tmp/report.pdf")?.image).toBe(false)
  })

  test("🔴 a web URL resolves to nothing — the renderer must leave it alone", () => {
    // The safe direction. Rewriting a working external link is a regression the user sees; ignoring
    // a file link is a link that still reads as text.
    expect(resolveAgentFile("https://novaclaw.app")).toBeUndefined()
  })
})

// 🔴 WHEN THE COLLEAGUE IS ON ANOTHER MACHINE (owner, 2026-08-22). A same-origin URL asks the user's
// own machine for a path that exists on the instance's — and the remote colleague is exactly the one
// whose files they cannot otherwise reach.
describe("addressing the instance the colleague runs on", () => {
  test("links point at the CONNECTED instance, not the page", () => {
    setInstanceBase("http://spark-0693.local:4096")
    expect(resolveAgentFile("/data/reports/q3.pdf")?.url).toBe(
      "http://spark-0693.local:4096/api/fs/read/q3.pdf?location%5Bdirectory%5D=%2Fdata%2Freports",
    )
    setInstanceBase("")
  })

  test("no connection yet is same-origin, which is the honest answer", () => {
    setInstanceBase(undefined)
    expect(resolveAgentFile("/tmp/a.txt")?.url).toBe("/api/fs/read/a.txt?location%5Bdirectory%5D=%2Ftmp")
  })

  test("the files browser downloads through the SAME resolver", () => {
    // Two surfaces asking one question. A second path-splitter would drift from this one.
    setInstanceBase("http://spark-0693.local:4096")
    // ⚠️ `toBe(string | undefined)` does not typecheck; the resolver's answer is asserted present
    // first, which is also the stronger claim — a resolver returning nothing here would be the bug.
    const resolved = resolveAgentFile("/data/reports/q3.pdf")
    expect(resolved).toBeDefined()
    expect(fileDownloadHref("/data/reports/q3.pdf")).toBe(resolved!.url)
    setInstanceBase("")
  })

  test("a path it cannot parse yields an empty href rather than a broken one", () => {
    expect(fileDownloadHref("not-a-path")).toBe("")
  })
})
