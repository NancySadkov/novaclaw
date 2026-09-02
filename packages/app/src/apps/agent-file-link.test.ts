import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { agentFileResolver, downloadHostFile, downloadHostPath, fileUrl, hostFile } from "./agent-file-link"
import { setInstanceBase, setInstanceTicketMinter } from "./instance-origin"

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

  test("🔴 a path rooted on ANOTHER MACHINE is not a host file", () => {
    // The href decides which host the INSTANCE opens a connection to, and in the chat log the href
    // was written by a model repeating untrusted content. Every spelling of the same destination:
    for (const href of [
      "//attacker.example/share/chart.png",
      String.raw`\\attacker.example\share\chart.png`,
      "file://///attacker.example/share/chart.png",
      "///attacker.example/share/chart.png",
    ])
      expect({ href, file: hostFile(href) }).toEqual({ href, file: undefined })
  })

  test("the refusal is about the ROOT, not the words — a local path with the same name resolves", () => {
    // Negative control: without this the test above would pass on a parser that had stopped
    // recognising files at all.
    expect(hostFile("/share/chart.png")).toEqual({ directory: "/share", name: "chart.png", image: true })
    expect(hostFile("C:/share/chart.png")?.name).toBe("chart.png")
  })

  test("a share is readable when the CALLER says the user chose it", () => {
    // The Files browser opts in; nothing that reads model output does. The option is what makes the
    // distinction a property of the call site rather than of a string.
    expect(hostFile("//fileserver/team/q3.pdf", { remote: true })).toEqual({
      directory: "//fileserver/team",
      name: "q3.pdf",
      image: false,
    })
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
    expect(url).toBe(
      "http://127.0.0.1:4096/api/fs/read/a%20chart.svg?location%5Bdirectory%5D=C%3A%2Fmy%20data%2Fscratch",
    )
  })

  test("a trailing slash on the base does not double up", () => {
    expect(fileUrl("http://x/", { directory: "/tmp", name: "a.txt", image: false })).toContain("http://x/api/fs/read/")
  })

  test("a ticket rides the query when there is one, and the parameter is absent when there is not", () => {
    const file = { directory: "/tmp", name: "a.txt", image: false }
    expect(fileUrl("http://x", file, "tk 1")).toBe(
      "http://x/api/fs/read/a.txt?location%5Bdirectory%5D=%2Ftmp&ticket=tk%201",
    )
    expect(fileUrl("http://x", file)).not.toContain("ticket")
  })

  /**
   * 🔴 A TICKET, NEVER `auth_token`. That parameter is `btoa("user:password")` — the instance's own
   * password — and `workspaceProxyURL` copies a request's whole query string into its proxy target,
   * so a request merely passing through an instance would carry that instance's password to a
   * machine that is not ours. The narrowing in the authorization middleware exists because that
   * happened. A ticket names one file, works once and expires in a minute.
   */
  test("🔴 no credential ever rides this URL", () => {
    const url = fileUrl("http://x", { directory: "/tmp", name: "a.txt", image: false }, "tk-1")
    expect(url).not.toContain("auth_token")
    expect(url).not.toContain("password")
  })
})

describe("the resolver the renderer is handed", () => {
  /**
   * 🔴 **THERE IS NO URL IN A RESOLVED TARGET, and that is the fix.**
   *
   * It used to carry `url` — the instance route serving the file — and the renderer wrote it into
   * an `<a href download>`. A `download` href is fetched by the BROWSER, and a browser-issued
   * request carries no `Authorization` header, so on any instance with a server password the click
   * saved the 401 body under the file's own name. The member is gone: a renderer can only emit what
   * it is handed, so the URL cannot reappear in an attribute by anyone forgetting anything.
   */
  test("a host image is named and marked, and carries no URL at all", () => {
    expect(agentFileResolver.target("/tmp/chart.svg")).toEqual({ name: "chart.svg", image: true })
  })

  test("a host file resolves, and is NOT an image", () => {
    expect(agentFileResolver.target("/tmp/report.pdf")?.image).toBe(false)
  })

  test("🔴 a web URL resolves to nothing — the renderer must leave it alone", () => {
    // The safe direction. Rewriting a working external link is a regression the user sees; ignoring
    // a file link is a link that still reads as text.
    expect(agentFileResolver.target("https://novaclaw.app")).toBeUndefined()
  })
})

/**
 * 🔴 WHAT THE BROWSER IS ACTUALLY HANDED WHEN THE USER CLICKS.
 *
 * `downloadHostFile` mints a ticket, then creates an anchor, sets its `href` and `download`, and
 * clicks it — so the browser streams the file itself and a large artefact never has to fit in a JS
 * string. These tests intercept `HTMLAnchorElement.prototype.click` rather than a seam invented for
 * them, so what is asserted is the URL the real code path gives a real element.
 *
 * 🔴 **Addressing the instance the colleague RUNS ON** (owner, 2026-08-22): a same-origin URL asks
 * the user's own machine for a path that exists on the instance's, and the remote colleague is
 * exactly the one whose files they cannot otherwise reach.
 */
describe("the download click", () => {
  const clicked: { href: string; download: string }[] = []
  const native = HTMLAnchorElement.prototype.click

  beforeEach(() => {
    clicked.length = 0
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push({ href: this.getAttribute("href") ?? "", download: this.download })
    }
  })

  afterEach(() => {
    HTMLAnchorElement.prototype.click = native
    setInstanceTicketMinter(undefined)
    setInstanceBase("")
  })

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  test("mints a ticket for THIS file and hands the browser a URL carrying it", async () => {
    const asked: string[] = []
    setInstanceBase("http://spark-0693.local:4096")
    setInstanceTicketMinter(async (directory, name) => {
      asked.push(directory + "|" + name)
      return "tk-42"
    })

    downloadHostFile("/data/reports/q3.pdf")
    await settle()

    expect(asked).toEqual(["/data/reports|q3.pdf"])
    expect(clicked).toEqual([
      {
        href: "http://spark-0693.local:4096/api/fs/read/q3.pdf?location%5Bdirectory%5D=%2Fdata%2Freports&ticket=tk-42",
        download: "q3.pdf",
      },
    ])
  })

  test("🔴 the ticket is minted at CLICK time, once per click — never once per render", async () => {
    // A ticket baked into markup is spent by the first paint: the chat replays rendered HTML from a
    // 200-entry content-addressed LRU and `/api/fs/read` sets no cache headers. Two clicks must
    // therefore be two tickets.
    const minted: string[] = []
    setInstanceTicketMinter(async () => {
      const ticket = "tk-" + minted.length
      minted.push(ticket)
      return ticket
    })

    downloadHostFile("/tmp/a.txt")
    await settle()
    downloadHostFile("/tmp/a.txt")
    await settle()

    expect(minted).toEqual(["tk-0", "tk-1"])
    expect(clicked.map((entry) => entry.href)).toEqual([
      "/api/fs/read/a.txt?location%5Bdirectory%5D=%2Ftmp&ticket=tk-0",
      "/api/fs/read/a.txt?location%5Bdirectory%5D=%2Ftmp&ticket=tk-1",
    ])
  })

  test("a refused mint degrades to the unticketed URL rather than to nothing", async () => {
    // Which is exactly what HEAD always sent: an instance with no password serves it, and one with
    // a password answers the same 401 it did before. Doing nothing at all would be worse than the
    // bug this replaces.
    setInstanceTicketMinter(async () => {
      throw new Error("mint refused")
    })

    downloadHostFile("/tmp/a.txt")
    await settle()

    expect(clicked).toEqual([{ href: "/api/fs/read/a.txt?location%5Bdirectory%5D=%2Ftmp", download: "a.txt" }])
  })

  test("nothing connected still downloads, same-origin and unticketed", async () => {
    downloadHostFile("/tmp/a.txt")
    await settle()
    expect(clicked.map((entry) => entry.href)).toEqual(["/api/fs/read/a.txt?location%5Bdirectory%5D=%2Ftmp"])
  })

  test("a path it cannot parse downloads nothing at all", async () => {
    setInstanceTicketMinter(async () => "tk-1")
    downloadHostFile("not-a-path")
    await settle()
    expect(clicked).toEqual([])
  })

  /**
   * 🔴 The remote-root refusal is re-applied HERE, on the value that came back out of an attribute.
   *
   * `//host/share/x` is a network destination wearing a path's clothes: fetching it opens an SMB
   * connection to a host an attacker named, which on Windows hands over an NTLM exchange. The path
   * travels from the renderer to this function through a DOM attribute, so a guard applied only
   * before it was written there is a guard a replayed or hand-edited attribute walks straight past.
   */
  test("🔴 the chat click refuses a remote root; the Files browser, where the user chose it, does not", async () => {
    setInstanceTicketMinter(async () => "tk-1")

    downloadHostFile("//fileserver/team/q3.pdf")
    await settle()
    expect(clicked).toEqual([])

    downloadHostPath("//fileserver/team/q3.pdf")
    await settle()
    expect(clicked).toHaveLength(1)
    expect(clicked[0]!.href).toContain("%2F%2Ffileserver%2Fteam")
  })

  test("the chat's resolver and the Files browser reach the same download", async () => {
    // Two surfaces asking one question. A second path-splitter would drift from this one.
    setInstanceTicketMinter(async () => "tk-1")

    agentFileResolver.download("/data/reports/q3.pdf")
    await settle()
    downloadHostPath("/data/reports/q3.pdf")
    await settle()

    expect(clicked).toHaveLength(2)
    expect(clicked[0]).toEqual(clicked[1]!)
  })
})
