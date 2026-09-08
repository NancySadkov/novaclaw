import { normalizeTheme } from "shiki/core"

export const createTheme = ({ name, load, colorScheme, collection, displayName }) => ({
  name,
  colorScheme,
  collection,
  displayName,
  load: async () => {
    const loaded = await load()
    return normalizeTheme(loaded?.default ?? loaded)
  },
})

const none = Object.freeze([])
const empty = Object.freeze({
  getTheme: () => undefined,
  getThemes: () => none,
  getThemeNames: () => none,
  hasTheme: () => false,
  orderBy: () => empty,
  pick: () => empty,
  registerInto: () => undefined,
})

export const pierreThemes = empty
export const shikiThemes = empty
export const themes = empty
