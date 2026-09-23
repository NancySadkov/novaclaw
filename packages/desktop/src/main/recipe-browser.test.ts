import { expect, test } from "bun:test"
import { isRecipeNavigation, recipeBrowserURL } from "./recipe-browser"

const entry = "http://127.0.0.1:4096/api/recipe-preview/weather/weather.123.abc.def/index.html"

test("dedicated recipe browser keeps navigation inside one deployment ticket", () => {
  const origin = recipeBrowserURL(entry)
  expect(isRecipeNavigation(origin, entry.replace("index.html", "sub/page.html"))).toBe(true)
  expect(isRecipeNavigation(origin, entry.replace("preview/weather", "preview/other"))).toBe(false)
  expect(isRecipeNavigation(origin, entry.replace("weather.123.abc.def", "weather.456.abc.def"))).toBe(false)
  expect(isRecipeNavigation(origin, "https://example.com/")).toBe(false)
  expect(isRecipeNavigation(origin, "file:///etc/passwd")).toBe(false)
})

test("recipe browser refuses credential and query-bearing URLs", () => {
  expect(() => recipeBrowserURL(entry.replace("127.0.0.1", "u:p@127.0.0.1"))).toThrow()
  expect(() => recipeBrowserURL(`${entry}?auth_token=secret`)).toThrow()
})
