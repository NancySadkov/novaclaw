import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

// The outbound-link ledger.
//
// "This URL is live" is a claim about the world, and a wrong one compiles green, renders perfectly, and
// only fails in the user's hands. That is how `novaclaw.app/desktop-feedback` — 404 since v0.1.0 — stayed
// wired to the CRASH SCREEN's "report this error" button and to the sidebar Help button: the only two
// places a stuck person is offered a way out both went nowhere, and nothing in the tree could notice.
//
// So the invariant gets a mechanical check (todo.md standing decision 2). It is deliberately STATIC — the
// unit suite is hermetic and must pass airgapped, so this never touches the network. What it enforces is
// that the claim is WRITTEN DOWN: every novaclaw.app / discord.gg URL in the renderer must be declared
// here with an honest status, a new one cannot appear without someone declaring it, a retired one cannot
// quietly return, and a URL that is not declared LIVE cannot be reached from a last-resort surface.
//
// Statuses are verified by hand against the real site; re-verify when the site changes.
//   live       — checked and serving (2026-07-28)
//   dead       — checked and 404 (2026-07-28)
//   unverified — never checked; treated as NOT live everywhere it matters

type Status = "live" | "dead" | "unverified"

type Entry = {
  /** Path relative to packages/app/src, forward slashes. */
  file: string
  url: string
  status: Status
  note: string
}

const LEDGER: Entry[] = [
  {
    file: "constants/links.ts",
    url: "https://discord.gg/QShqKW56JM",
    status: "live",
    note: "The community invite. The single copy in the renderer; crash screen, Help button and Community panel all resolve to it.",
  },
  {
    file: "pages/home-screen/social-panel.tsx",
    url: "https://novaclaw.app",
    status: "live",
    note: "The product site root, opened from the Community panel.",
  },
  {
    file: "desktop-menu.ts",
    url: "https://novaclaw.app/docs",
    status: "dead",
    note: "Help → 'NovaClaw Documentation' in the desktop menu bar. 404: no docs site has been published yet. Left pointing at the intended home rather than repointed at Discord — a menu item that says Documentation must not open a chat server (standing decision 3: a fault is never described falsely). Fixing it means publishing /docs.",
  },
  {
    file: "components/settings-general.tsx",
    url: "https://novaclaw.app/docs/themes/",
    status: "dead",
    note: "Settings → Appearance 'Learn more' (legacy settings surface). Same 404 as /docs.",
  },
  {
    file: "components/settings-v2/appearance.tsx",
    url: "https://novaclaw.app/docs/themes/",
    status: "dead",
    note: "Settings v2 → Appearance 'Learn more'. Same 404 as /docs.",
  },
  {
    file: "context/highlights.tsx",
    url: "https://novaclaw.app/changelog.json",
    status: "dead",
    note: "Fetched to build the What's-new highlights. Still 404, so the dialog is unreachable — but the fetch no longer fails silently (U5, 2026-07-28): the 404 is classified apart from a network failure and from a genuinely empty changelog, named in the Debug app's error log, and the version is marked seen so it stops re-fetching every launch. Not repointable — Discord is not a changelog; fixing it means publishing the file. See context/highlights.test.ts.",
  },
  {
    file: "pages/layout/helpers.ts",
    url: "https://novaclaw.app/favicon.svg",
    status: "unverified",
    note: "Project-icon fallback for the NovaClaw pseudo-project. An <img> src, not a navigation: a miss degrades to a broken icon, never a dead end.",
  },
  {
    file: "components/settings-v2/config-io.tsx",
    url: "https://novaclaw.app/config.json",
    status: "unverified",
    note: "A JSON Schema $schema identifier written into exported config, not a link the UI opens. Only an editor resolving the schema would fetch it.",
  },
]

/**
 * URLs that were shipped, found broken, and removed. They must never reappear anywhere in the renderer —
 * including behind a fresh `status: "live"` claim in the ledger above.
 */
const RETIRED = [
  {
    url: "https://novaclaw.app/desktop-feedback",
    note: "404 since v0.1.0. Was the crash screen's 'report this error' link and the sidebar Help button; both now resolve to DISCORD_INVITE_URL (B3, 2026-07-28).",
  },
]

/**
 * Last-resort surfaces: what the user reaches when the product is ALREADY broken, or when they have given
 * up and pressed Help. Everything reachable from here must be declared live, and there must be something
 * to reach — deleting the link is not a fix.
 */
// `pages/layout.tsx` used to be listed here for the legacy shell's sidebar Help button. That shell
// is deleted; the Community panel on the home screen is now the non-crash way out.
const LAST_RESORT = ["pages/error.tsx", "pages/home-screen/social-panel.tsx"]

const SRC = path.resolve(import.meta.dir, "..")
const LINKS_MODULE = "constants/links.ts"
const URL_PATTERN = /https:\/\/(?:novaclaw\.app|discord\.gg)[^\s"'`)<>\\]*/g

function sourceFiles(): string[] {
  return fs
    .readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .map((entry) => entry.split(path.sep).join("/"))
    .filter((rel) => /\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel))
    .filter((rel) => fs.statSync(path.join(SRC, rel)).isFile())
}

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), "utf8")
}

/** Every (file, url) pair a literal URL appears at, one row per distinct pair. */
function found(): { file: string; url: string }[] {
  const out: { file: string; url: string }[] = []
  const seen = new Set<string>()
  for (const file of sourceFiles()) {
    for (const url of read(file).match(URL_PATTERN) ?? []) {
      const key = `${file}\x00${url}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ file, url })
    }
  }
  return out
}

/** `export const NAME = "url"` in constants/links.ts. */
function exportedLinks(): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of read(LINKS_MODULE).matchAll(/export const (\w+)\s*=\s*"([^"]+)"/g)) out.set(m[1]!, m[2]!)
  return out
}

/** Everything `file` can open: literal URLs plus the values of link constants it imports. */
function reachableFrom(file: string): string[] {
  const source = read(file)
  const urls = new Set(source.match(URL_PATTERN) ?? [])
  const exported = exportedLinks()
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@\/constants\/links["']/g)) {
    for (const raw of m[1]!.split(",")) {
      const name = raw
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim()
      const url = name ? exported.get(name) : undefined
      if (url) urls.add(url)
    }
  }
  return [...urls]
}

describe("outbound link ledger", () => {
  test("every novaclaw.app / discord.gg URL in the renderer is declared", () => {
    const declared = new Set(LEDGER.map((e) => `${e.file}\x00${e.url}`))
    const undeclared = found().filter((f) => !declared.has(`${f.file}\x00${f.url}`))
    expect(
      undeclared.map((f) => `${f.file} → ${f.url}`),
      "Undeclared outbound URL. Add it to LEDGER in constants/links.test.ts with an honest status — " +
        "an unchecked link is how the crash screen ended up pointing at a 404.",
    ).toEqual([])
  })

  test("no ledger entry has gone stale", () => {
    const live = new Set(found().map((f) => `${f.file}\x00${f.url}`))
    const stale = LEDGER.filter((e) => !live.has(`${e.file}\x00${e.url}`))
    expect(
      stale.map((e) => `${e.file} → ${e.url}`),
      "Ledger entry no longer present in the source. Remove it — a ledger nobody prunes stops being read.",
    ).toEqual([])
  })

  test("every entry carries a reason someone can act on", () => {
    for (const entry of LEDGER) expect(entry.note.length, `${entry.file} → ${entry.url}`).toBeGreaterThan(30)
  })

  test("retired URLs have not come back", () => {
    const all = found()
    for (const retired of RETIRED) {
      const back = all.filter((f) => f.url === retired.url).map((f) => f.file)
      expect(back, `${retired.url} was retired: ${retired.note}`).toEqual([])
    }
  })
})

describe("the community invite has exactly one home", () => {
  test("the invite string is written once, in constants/links.ts", () => {
    const invite = exportedLinks().get("DISCORD_INVITE_URL")
    expect(invite, "DISCORD_INVITE_URL must stay exported from constants/links.ts").toBeTruthy()
    const holders = found()
      .filter((f) => f.url === invite)
      .map((f) => f.file)
    expect(holders, "Import DISCORD_INVITE_URL instead of pasting the invite — copies rot apart silently.").toEqual([
      LINKS_MODULE,
    ])
  })

  test("the crash screen and the Community panel both use it", () => {
    for (const file of ["pages/error.tsx", "pages/home-screen/social-panel.tsx"]) {
      expect(read(file), `${file} should import DISCORD_INVITE_URL`).toContain("DISCORD_INVITE_URL")
    }
  })
})

describe("last-resort surfaces never dead-end", () => {
  // The user is here because something already broke. A link that 404s now is worse than no link: it
  // spends the last bit of trust they had. Nothing but a verified-live endpoint is allowed.
  const statusOf = new Map(LEDGER.map((e) => [e.url, e.status]))

  for (const file of LAST_RESORT) {
    test(`${file} offers a way out`, () => {
      expect(reachableFrom(file).length, `${file} must link somewhere a stuck user can get help`).toBeGreaterThan(0)
    })

    test(`${file} links only to endpoints declared live`, () => {
      const bad = reachableFrom(file).map((url) => ({ url, status: statusOf.get(url) ?? "undeclared" }))
      expect(
        bad.filter((x) => x.status !== "live").map((x) => `${x.url} (${x.status})`),
        `${file} is reached when the product is already broken — every link on it must be declared live.`,
      ).toEqual([])
    })
  }
})
