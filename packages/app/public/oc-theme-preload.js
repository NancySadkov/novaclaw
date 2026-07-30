;(function () {
  var key = "novaclaw-theme-id"
  var themeId = localStorage.getItem(key) || "nova"

  // `oc-1`/`oc-2` are opencode's ids, retired in favour of the brand default. Mirrors
  // LEGACY_THEME_IDS in @novaclaw/ui/theme/default-theme — kept as a literal here because the
  // first-paint script runs before any module loads and must stay dependency-free.
  if (themeId === "oc-1" || themeId === "oc-2") {
    themeId = "nova"
    localStorage.setItem(key, themeId)
    localStorage.removeItem("novaclaw-theme-css-light")
    localStorage.removeItem("novaclaw-theme-css-dark")
  }

  var scheme = localStorage.getItem("novaclaw-color-scheme") || "system"
  var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  var mode = isDark ? "dark" : "light"

  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode
  document.documentElement.style.backgroundColor = isDark ? "#080808" : "#fafafa"

  // Update theme-color meta tag to match app color scheme
  var metas = document.querySelectorAll("meta[name='theme-color']")
  if (metas.length > 0) metas[0].setAttribute("content", isDark ? "#080808" : "#fafafa")

  if (themeId === "nova") return

  var css = localStorage.getItem("novaclaw-theme-css-" + mode)
  if (css) {
    var style = document.createElement("style")
    style.id = "oc-theme-preload"
    style.textContent =
      ":root{color-scheme:" +
      mode +
      ";--text-mix-blend-mode:" +
      (isDark ? "plus-lighter" : "multiply") +
      ";" +
      css +
      "}"
    document.head.appendChild(style)
  }
})()
