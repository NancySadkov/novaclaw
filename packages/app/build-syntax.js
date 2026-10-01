import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import supported from "./syntax-languages.json" with { type: "json" }

const require = createRequire(import.meta.url)
const catalogue = require.resolve("shiki/langs")
const languages = createRequire(catalogue)
const virtual = "\0nova-syntax-languages"

export async function syntaxLanguageInfo() {
  const { bundledLanguagesInfo } = await import(pathToFileURL(catalogue).href)
  const selected = supported.map((id) => bundledLanguagesInfo.find((item) => item.id === id))
  if (selected.some((item) => !item) || new Set(supported).size !== supported.length)
    throw new Error("The supported syntax language catalogue is invalid")
  return selected
}

export function syntaxLanguages() {
  return {
    name: "novaclaw:syntax-languages",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "shiki/langs" || source === "@shikijs/langs") return virtual
      if (importer === virtual && source.startsWith("@shikijs/langs/")) return languages.resolve(source)
    },
    async load(id) {
      if (id !== virtual) return
      const info = await syntaxLanguageInfo()
      return [
        `export const bundledLanguagesInfo = [${info.map(({ import: _loader, ...item }) => `{...${JSON.stringify(item)},import:()=>import(${JSON.stringify("@shikijs/langs/" + item.id)})}`).join(",")}];`,
        "export const bundledLanguagesBase = Object.fromEntries(bundledLanguagesInfo.map(item=>[item.id,item.import]));",
        "export const bundledLanguagesAlias = Object.fromEntries(bundledLanguagesInfo.flatMap(item=>(item.aliases??[]).map(alias=>[alias,item.import])));",
        "export const bundledLanguages = {...bundledLanguagesBase,...bundledLanguagesAlias};",
      ].join("\n")
    },
  }
}
