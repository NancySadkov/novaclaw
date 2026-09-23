const RECIPE_PAGE = /^\/api\/recipe-preview\/([a-z0-9][a-z0-9-_]{0,63})\/([a-z0-9][a-z0-9-_.]{0,180})\/(.+)$/

export function recipeBrowserURL(address: string): URL {
  const url = new URL(address)
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !RECIPE_PAGE.test(url.pathname) ||
      url.username || url.password || url.search || url.hash)
    throw new Error("Invalid deployed recipe page")
  return url
}

export function isRecipeNavigation(initial: URL, address: string): boolean {
  try {
    const next = recipeBrowserURL(address)
    const first = RECIPE_PAGE.exec(initial.pathname)
    const second = RECIPE_PAGE.exec(next.pathname)
    return next.origin === initial.origin && first?.[1] === second?.[1] && first?.[2] === second?.[2]
  } catch {
    return false
  }
}
