import { useNavigate } from "@solidjs/router"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useChatsAttention } from "@/apps/chats-attention"
import { systemLoadStats, useSystemLoad } from "@/apps/system-load"
import { useSettingsNavigation } from "@/components/settings-navigation"
import { HelpTour } from "@/pages/home-screen/help-tour"
import { SocialPanel } from "@/pages/home-screen/social-panel"
import { appName, appSubtitle, BUILTIN_APP_LABELS, type BuiltinAppId, type Translate } from "./app-label"
import type { HomeApp } from "./registry"

// The built-in NovaClaw apps. Each `open()` REUSES an existing opener (route navigation, a dialog, the
// settings surface) — nothing is re-implemented. Returned from a hook so the openers bind to the
// current component scope; the home screen merges these with `registeredApps()` (plugin / agent apps).
//
// App-set decisions (2026-07-01, refined 2026-07-02): there is NO "New Chat" tile — new sessions live
// inside the Chats app, which is the HERO tile (the one eye-anchor; everything else is done through
// chat with an agent). Models is its OWN home app (owner, 2026-09-16 — it outgrew a Settings tab), and
// Devices remain Settings tabs. Notes / Files route to real pages/dialogs. Trash was a tile until
// 2026-09-16, when it folded into Settings → Safety. ⚠️ **Every tile here opens something real** — the last
// placeholder (Search) was retired 2026-08-11, and a tile whose `open()` apologises must not come
// back: on a launcher, a tile IS a promise that the thing exists.
//
// Tile palette: gold is reserved for the hero (the single warm accent on the cool purple field —
// that contrast is what guides the eye); every other tile gets a cool hue so none competes.
//
// ⚠️ Words come from `home.app.<id>.{name,subtitle}` (see `app-label.ts`), NOT from literals here.
// They used to be hardcoded English, which made the most visible strings in the product the only ones
// the language picker could not reach. The English text still exists once, in `BUILTIN_APP_LABELS`,
// as the fallback for a build whose keys went missing — `app-label.test.ts` pins it against `en`.
export function useBuiltinApps(): () => HomeApp[] {
  const navigate = useNavigate()
  const dialog = useDialog()
  const language = useLanguage()
  const openSettings = useSettingsNavigation()
  const chatsAttention = useChatsAttention()
  const systemLoad = useSystemLoad()

  // `t` is typed to the literal key union; `home.app.<id>.*` is assembled at runtime because a
  // contributed app's id is not known at build time. Same bridge `help-tour.tsx` uses per step.
  const t: Translate = (key, params) => language.t(key as Parameters<typeof language.t>[0], params)
  const name = (id: BuiltinAppId) => appName(t, id, BUILTIN_APP_LABELS[id].name)
  // Every built-in ships a subtitle, so this narrows to `string` — `appSubtitle` returns `undefined`
  // only when there is nothing at all to say, which cannot happen for an entry in the table.
  const sub = (id: BuiltinAppId): string =>
    appSubtitle(t, id, BUILTIN_APP_LABELS[id].subtitle) ?? BUILTIN_APP_LABELS[id].subtitle

  // 🔴 ONE array, ONE object per app, built ONCE — not a fresh literal per call (review H2,
  // 2026-08-23). `<For>` keys by REFERENCE, so a factory that minted new objects on every call gave
  // every tile a new identity on every recomputation of the home screen's `apps` memo: solid then
  // disposed and recreated the entire grid instead of moving nodes. Measured with solid's own
  // `mapArray`: a drag-release went from 3 tile mounts to 6, and each rebuilt tile re-ran
  // `createSortable()` — re-registering with solid-dnd MID-GESTURE — rebuilt its classList effects
  // and recreated its `<img>`. It also fired whenever an agent app registered or a manifest loaded.
  //
  // ⚠️ `title` and `subtitle` are GETTERS, not values. They read the language context, so they must
  // stay reactive — a getter keeps the object identity stable while the field still tracks, which is
  // the same trick `badge`/`stats` already use as thunks (`app-tile.tsx:56-58`).
  const apps: HomeApp[] = [
    {
      id: "contacts",
      get title() {
        return name("contacts")
      },
      icon: "speech-bubble",
      tile: "/assets/skin/tiles/tasks.png",
      // The hero's accent IS the preset's primary accent, so the one eye-anchor re-themes with the
      // color scheme (gold on Nova, amber on Autumn, coral on Summer). uix.md §7.
      accent: "var(--nc-accent-solid)",
      glyphTone: "dark",
      hero: true,
      // Not rendered ON the hero any more — the tile shows live numbers instead — but still the
      // tile's accessible description and its tooltip, so it stays a sentence about what opens.
      get subtitle() {
        return sub("contacts")
      },
      source: "builtin",
      // ⚠️ The hero opens the ROSTER, not a chat list — one door, because a second tile onto the
      // same page is the "separate Contacts app" the owner ruled out.
      //
      // ⚠️ The id is `contacts`; the ROUTE and the ARTWORK are still `/tasks` and `tasks.png`, and
      // that split is deliberate rather than an oversight. This tile has been renamed twice
      // (`chats` → `tasks` → `contacts`), and `RENAMED_IDS` in `home-screen.tsx` maps BOTH old ids
      // onto `contacts` so a saved launcher arrangement keeps this tile in its slot. Renaming it
      // again means adding a row there in the same edit — a lookup, not a chain, so every old name
      // must point at where the tile lives TODAY.
      // The hero IS the system monitor: threads running, combined throughput, memory pressure.
      stats: () => systemLoadStats(systemLoad(), language.t),
      open: () => navigate("/tasks"),
      // Threads wanting attention (pending question + unseen) — uix-improvement slice 2.
      badge: () => chatsAttention().length || undefined,
    },
    {
      id: "models",
      get title() {
        return name("models")
      },
      icon: "cpu",
      tile: "/assets/skin/glyphs/models-generated.png",
      tileNeedsFrame: true,
      accent: "#14b8a6",
      get subtitle() {
        return sub("models")
      },
      source: "builtin",
      // Its own screen, exactly like the roster: managing models is a place you go, not a dialog you
      // dismiss into the settings you were already in.
      open: () => navigate("/models"),
    },
    {
      id: "recipes",
      get title() {
        return name("recipes")
      },
      icon: "checklist",
      tile: "/assets/skin/glyphs/recipes-generated.png",
      tileNeedsFrame: true,
      accent: "#9b8acb",
      get subtitle() {
        return sub("recipes")
      },
      source: "builtin",
      open: () => navigate("/recipes"),
    },
    {
      id: "files",
      get title() {
        return name("files")
      },
      icon: "folder",
      tile: "/assets/skin/glyphs/files-generated.png",
      tileNeedsFrame: true,
      accent: "#3b82f6",
      get subtitle() {
        return sub("files")
      },
      source: "builtin",
      open: () => navigate("/files"),
    },
    // Processes RETIRED (uix-improvement slice 6): Chats absorbed the user-facing view (threads
    // tree, status pills-as-attention, tokens in the info sheet). The Developer `ps` — kill /
    // suspend, scheduler snapshot, raw ids — lands in the future Debug app (todo.md → Make UIX
    // perfect). The "processes" id stays RESERVED so a plugin can't squat it meanwhile.
    // Search RETIRED (owner, 2026-08-11). It was never a feature: it shipped with the very first
    // launcher commit (`ce59aaccc`) as a tile whose `open()` was a "coming soon" panel, promising
    // "find anything across chats and files" and doing nothing. Asking an agent IS the search — a
    // tile that opens an apology teaches the opposite of the chat-first model it claimed to teach.
    // The id stays RESERVED (like `processes`) so nothing can squat the name.
    {
      id: "terminal",
      get title() {
        return name("terminal")
      },
      icon: "terminal",
      tile: "/assets/skin/glyphs/terminal-generated.png",
      tileNeedsFrame: true,
      accent: "#64748b",
      get subtitle() {
        return sub("terminal")
      },
      source: "builtin",
      // Chat is the shell for everyone else; the raw terminal appears only after the user opts into
      // Advanced or Developer expertise. Its PTY always runs on the selected instance.
      minLevel: "advanced",
      open: () => navigate("/terminal"),
    },
    {
      id: "debug",
      get title() {
        return name("debug")
      },
      icon: "console",
      tile: "/assets/skin/glyphs/debug-generated.png",
      tileNeedsFrame: true,
      accent: "#a78bfa",
      get subtitle() {
        return sub("debug")
      },
      source: "builtin",
      // Raw diagnostics are a Developer surface (uix.md §6.4; dependability P5 — the calm
      // banner/ErrorPage stay clean, the detail lives here).
      minLevel: "developer",
      open: () => navigate("/debug"),
    },
    // Trash RETIRED as a tile (owner, 2026-09-16): it is a Settings tab under Safety now, where its
    // restore list and its retention control share one screen. The id stays RESERVED so nothing can
    // squat a name users still reach for, and the `/trash` route and page are gone with the tile.
    {
      id: "social",
      get title() {
        return name("social")
      },
      icon: "community",
      tile: "/assets/skin/glyphs/swarm-generated.png",
      tileNeedsFrame: true,
      accent: "#7062ae",
      get subtitle() {
        return sub("social")
      },
      source: "builtin",
      open: () => void dialog.show(() => <SocialPanel />),
    },
    {
      id: "help",
      get title() {
        return name("help")
      },
      icon: "help",
      tile: "/assets/skin/glyphs/help-generated.png",
      tileNeedsFrame: true,
      // Cool indigo, not the old pink — keeps the single-warm-accent discipline. uix.md §3/P3.
      accent: "#6366f1",
      get subtitle() {
        return sub("help")
      },
      source: "builtin",
      open: () => void dialog.show(() => <HelpTour />),
    },
    {
      id: "settings",
      get title() {
        return name("settings")
      },
      icon: "settings-gear",
      tile: "/assets/skin/glyphs/settings-generated.png",
      tileNeedsFrame: true,
      accent: "#8d8fa6",
      get subtitle() {
        return sub("settings")
      },
      source: "builtin",
      open: () => openSettings(),
    },
  ]
  return () => apps
}
