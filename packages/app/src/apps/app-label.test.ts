import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dict as en } from "@/i18n/en"
import {
  appLabelKey,
  appName,
  appSubtitle,
  BUILTIN_APP_LABELS,
  hasAppLabel,
  legibleAppName,
  nameFromId,
  type BuiltinAppId,
  type Translate,
} from "./app-label"
import { registerApp, registeredApps, unregisterApp } from "./registry"

// The home launcher's tiles were hardcoded English until `home.app.<id>.*` landed. Two things need
// pinning, and neither is visible to a typechecker:
//
//   (1) every built-in tile actually HAS its keys, in both directions, so a new tile cannot ship
//       untranslatable and a key cannot outlive the tile it names;
//   (2) an app we did NOT write — plugin or AI-agent-contributed — renders words, never a raw key,
//       whether or not our bundles have ever heard of it.

/** A translator over an explicit dictionary that records what it was asked for. */
function translator(dict: Record<string, string>) {
  const asked: string[] = []
  // The cast mirrors production: `useLanguage().t` is declared to return `string` but resolves to
  // `undefined` for a key the dictionary lacks. If `appName` ever asked for an unshipped key, this
  // stub would hand back `undefined` exactly as the real one does.
  const t: Translate = (key) => {
    asked.push(key)
    return dict[key] as string
  }
  return { t, asked }
}

/** How `context/language.tsx` builds a locale: `en` as the base, the locale spread over it. */
const merged = (locale: Record<string, string>) => ({ ...(en as Record<string, string>), ...locale })

const BUILTIN_IDS = Object.keys(BUILTIN_APP_LABELS) as BuiltinAppId[]

describe("home tile labels", () => {
  describe("every built-in tile is translatable", () => {
    test("each built-in has both `home.app.<id>.*` keys in en, byte-identical to its fallback", () => {
      const wrong: string[] = []
      for (const id of BUILTIN_IDS) {
        for (const field of ["name", "subtitle"] as const) {
          const key = appLabelKey(id, field)
          const shipped = (en as Record<string, string>)[key]
          const fallback = BUILTIN_APP_LABELS[id][field]
          if (shipped === undefined) wrong.push(`${key} missing from en`)
          else if (shipped !== fallback)
            wrong.push(`${key}: en ${JSON.stringify(shipped)} !== fallback ${JSON.stringify(fallback)}`)
        }
      }
      expect(wrong).toEqual([])
    })

    // The other direction, so this is a ratchet and not a checklist: a `home.app.*` key whose tile
    // was deleted is dead weight 19 bundles would carry forever.
    test("every `home.app.*` key in en belongs to a built-in tile", () => {
      const owned = new Set(BUILTIN_IDS.flatMap((id) => [appLabelKey(id, "name"), appLabelKey(id, "subtitle")]))
      const orphans = Object.keys(en).filter((key) => key.startsWith("home.app.") && !owned.has(key))
      expect(orphans).toEqual([])
    })

    // …and the id set itself, against the file that actually registers the tiles. Without this the
    // table above could quietly describe a launcher nobody ships.
    test("the label table's ids are exactly the ids builtins.tsx registers", () => {
      const source = readFileSync(new URL("./builtins.tsx", import.meta.url), "utf8")
      const registered = [...source.matchAll(/^\s+id: "([^"]+)",$/gm)].map((match) => match[1]!)
      expect(registered.length).toBeGreaterThan(0)
      expect([...new Set(registered)].sort()).toEqual([...BUILTIN_IDS].sort())
    })
  })

  describe("resolution", () => {
    test("a built-in renders the active locale's text", () => {
      const { t } = translator(merged({ "home.app.chats.name": "Чаты", "home.app.chats.subtitle": "Ваши разговоры" }))
      expect(appName(t, "chats", BUILTIN_APP_LABELS.chats.name)).toBe("Чаты")
      expect(appSubtitle(t, "chats", BUILTIN_APP_LABELS.chats.subtitle)).toBe("Ваши разговоры")
    })

    test("a locale that has not translated the tile falls back to English, not to a key", () => {
      const { t } = translator(merged({}))
      expect(appName(t, "chats", BUILTIN_APP_LABELS.chats.name)).toBe("Chats")
      expect(appSubtitle(t, "memory-graph", BUILTIN_APP_LABELS["memory-graph"].subtitle)).toBe(
        "Explore what NovaClaw remembers, as a graph",
      )
    })

    test("a blank translation does not blank the tile", () => {
      const { t } = translator(merged({ "home.app.trash.name": "   ", "home.app.trash.subtitle": "" }))
      expect(appName(t, "trash", "Trash")).toBe("Trash")
      expect(appSubtitle(t, "trash", "Restore anything deleted in the last 2 days")).toBe(
        "Restore anything deleted in the last 2 days",
      )
    })
  })

  describe("an app we did not write", () => {
    test("keeps its own label with no key in any bundle — and the translator is never asked", () => {
      const { t, asked } = translator(merged({}))
      expect(hasAppLabel("stock-prices", "name")).toBe(false)
      expect(appName(t, "stock-prices", "Stock Prices")).toBe("Stock Prices")
      expect(appSubtitle(t, "stock-prices", "Watch a ticker")).toBe("Watch a ticker")
      // The "no raw key" property is structural: we only ask for keys this build ships, so a
      // contributed id can never reach `t` and can never come back as `undefined`.
      expect(asked).toEqual([])
    })

    test("starts translating for free the day someone contributes a key for it", () => {
      // `hasAppLabel` is membership in `en`, so this is what would happen after a key is added.
      const { t } = translator(merged({ "home.app.chats.name": "Sohbetler" }))
      expect(appName(t, "chats", "Chats")).toBe("Sohbetler")
    })

    test("a title that is really an i18n key degrades to a legible name, never renders raw", () => {
      const { t } = translator(merged({}))
      expect(appName(t, "stock-prices", "home.app.stock-prices.name")).toBe("Stock prices")
      expect(appName(t, "my_widget", "")).toBe("My widget")
      expect(appName(t, "my_widget", undefined)).toBe("My widget")
    })

    test("a subtitle is allowed to be absent — it is not invented from the id", () => {
      const { t } = translator(merged({}))
      expect(appSubtitle(t, "stock-prices", undefined)).toBeUndefined()
      expect(appSubtitle(t, "stock-prices", "   ")).toBeUndefined()
    })

    test("legibility is not vandalism: real titles that merely contain dots survive", () => {
      expect(legibleAppName("runtime", "Node.js")).toBe("Node.js")
      expect(legibleAppName("tools", "v2.1.0 tools")).toBe("v2.1.0 tools")
      expect(legibleAppName("x", "Ask.Me.Anything")).toBe("Ask.Me.Anything")
      // …while the actual failure shape does not.
      expect(legibleAppName("x", "home.app.x.name")).toBe("X")
      expect(nameFromId("")).toBe("App")
    })
  })

  describe("registerApp guards the seam", () => {
    const base = { icon: "cpu", accent: "#123456", source: "plugin", open: () => {} } as const
    const find = (id: string) => registeredApps().find((app) => app.id === id)

    test("a key-shaped or blank title is replaced before it can reach a tile", () => {
      registerApp({ ...base, id: "keyish", title: "home.app.keyish.name" })
      registerApp({ ...base, id: "blank", title: "  " })
      registerApp({ ...base, id: "fine", title: "Weather Radar" })
      try {
        expect(find("keyish")?.title).toBe("Keyish")
        expect(find("blank")?.title).toBe("Blank")
        expect(find("fine")?.title).toBe("Weather Radar")
      } finally {
        for (const id of ["keyish", "blank", "fine"]) unregisterApp(id)
      }
      expect(find("fine")).toBeUndefined()
    })

    test("no tile anywhere can end up displaying a bare i18n key", () => {
      const { t } = translator(merged({}))
      const ids = [...BUILTIN_IDS, "stock-prices", "a.b.c", "", "weird__id"]
      for (const id of ids) {
        const name = appName(t, id, `home.app.${id}.name`)
        expect(name.startsWith("home.app.")).toBe(false)
        expect(name.trim()).not.toBe("")
      }
    })
  })
})
