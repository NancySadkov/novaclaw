import { beforeEach, describe, expect, test } from "bun:test"
import { DEFAULT_THEME_ID, normalizeThemeId } from "@novaclaw/ui/theme/default-theme"

const src = await Bun.file(new URL("../public/oc-theme-preload.js", import.meta.url)).text()

const run = () => Function(src)()

beforeEach(() => {
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  localStorage.clear()
  Object.defineProperty(window, "matchMedia", {
    value: () =>
      ({
        matches: false,
      }) as MediaQueryList,
    configurable: true,
  })
})

describe("theme preload", () => {
  // The preload paints before the app mounts, so it picks a theme id on its own. Whatever it picks,
  // `ThemeProvider` normalizes it on mount — so the invariant that matters is not WHICH id the script
  // writes, it is that the id still resolves to a theme that exists. An id that fell out of
  // `LEGACY_THEME_IDS` and out of `themes/` would leave a user on an unknown theme (ruling 2).
  test("the id it picks on a virgin profile resolves to a real theme", () => {
    run()

    const painted = document.documentElement.dataset.theme
    expect(painted).toBeTruthy()
    expect(normalizeThemeId(painted)).toBe(DEFAULT_THEME_ID)
  })

  test("migrates the legacy id it knows about, and the result still resolves to the default", () => {
    localStorage.setItem("novaclaw-theme-id", "oc-1")
    localStorage.setItem("novaclaw-theme-css-light", "--background-base:#fff;")
    localStorage.setItem("novaclaw-theme-css-dark", "--background-base:#000;")

    run()

    expect(normalizeThemeId(document.documentElement.dataset.theme)).toBe(DEFAULT_THEME_ID)
    expect(document.documentElement.dataset.colorScheme).toBe("light")
    expect(normalizeThemeId(localStorage.getItem("novaclaw-theme-id"))).toBe(DEFAULT_THEME_ID)
    // Cached CSS belongs to the theme that was replaced — keeping it would paint the old theme.
    expect(localStorage.getItem("novaclaw-theme-css-light")).toBeNull()
    expect(localStorage.getItem("novaclaw-theme-css-dark")).toBeNull()
    expect(document.getElementById("oc-theme-preload")).toBeNull()
  })

  test("keeps cached css for non-default themes", () => {
    localStorage.setItem("novaclaw-theme-id", "nightowl")
    localStorage.setItem("novaclaw-theme-css-light", "--background-base:#fff;")

    run()

    expect(document.documentElement.dataset.theme).toBe("nightowl")
    expect(document.getElementById("oc-theme-preload")?.textContent).toContain("--background-base:#fff;")
  })
})
