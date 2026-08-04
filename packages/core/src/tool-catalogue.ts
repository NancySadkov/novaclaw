export * as ToolCatalogue from "./tool-catalogue"

import type { ToolDefinition } from "@novaclaw/llm"

export interface Source {
  readonly server: string
  readonly definition: ToolDefinition
}

export interface Row {
  readonly scope: string
  readonly name: string
  readonly server: string
  readonly description: string
  readonly argument_names: string
  readonly arguments: ReadonlyArray<{ readonly name: string; readonly description?: string }>
  readonly input_schema: unknown
  readonly keywords: string
}

export interface ManifestLine {
  readonly server: string
  readonly categories: ReadonlyArray<string>
}

const CORE_CATEGORIES: Readonly<Record<string, string>> = {
  apply_patch: "files",
  bash: "shell",
  configure: "configuration",
  define_tool: "knowledge",
  edit: "files",
  exit: "agents",
  glob: "files",
  grep: "files",
  js: "shell",
  kb: "knowledge",
  messenger: "messaging",
  permission: "configuration",
  profile: "configuration",
  quality_provision: "quality",
  question: "agents",
  read: "files",
  "read-hex": "files",
  recipe: "knowledge",
  reconfigure: "configuration",
  resource_status: "system",
  "register-app": "apps",
  revert: "files",
  skill: "knowledge",
  spawn: "agents",
  todowrite: "agents",
  tool_call: "knowledge",
  tool_search: "knowledge",
  tool_manual: "knowledge",
  trash: "files",
  wait: "agents",
  webfetch: "web",
  websearch: "web",
  write: "files",
  "write-hex": "files",
}

// A small deterministic vocabulary bridge closes common lexical gaps without making model-written
// catalogue prose a prompt-injection surface. These expansions are searched and never rendered.
const SYNONYMS: Readonly<Record<string, ReadonlyArray<string>>> = {
  account: ["user", "member", "person", "profile"],
  bash: ["shell", "terminal", "command", "script"],
  create: ["add", "make", "new", "open", "file"],
  delete: ["remove", "trash", "erase"],
  fetch: ["get", "retrieve", "load", "download"],
  issue: ["bug", "ticket", "problem", "report"],
  list: ["enumerate", "show", "browse"],
  message: ["chat", "conversation", "send", "reply"],
  read: ["get", "retrieve", "load", "view"],
  repository: ["repo", "project", "code"],
  search: ["find", "lookup", "query", "discover"],
  update: ["edit", "change", "modify", "save"],
  user: ["account", "member", "person", "profile"],
  web: ["internet", "site", "page", "url", "link"],
  write: ["edit", "change", "modify", "save"],
}

const GENERIC_ACTIONS = new Set([
  "add",
  "create",
  "delete",
  "fetch",
  "find",
  "get",
  "list",
  "read",
  "remove",
  "search",
  "set",
  "update",
  "write",
])

export function rows(scope: string, sources: ReadonlyArray<Source>): ReadonlyArray<Row> {
  return sources
    .map((source) => {
      const properties = schemaRecord(source.definition.inputSchema).properties
      const arguments_ = Object.entries(schemaRecord(properties)).map(([name, value]) => {
        const description = schemaRecord(value).description
        return typeof description === "string" && description.length > 0 ? { name, description } : { name }
      })
      const tokens = words(
        [source.definition.name, source.definition.description, ...arguments_.map((item) => item.name)].join(" "),
      )
      const keywords = [...new Set(tokens.flatMap((token) => SYNONYMS[token] ?? []))].sort().join(" ")
      return {
        scope,
        name: source.definition.name,
        server: source.server,
        description: source.definition.description,
        argument_names: arguments_.map((item) => item.name).join(" "),
        arguments: arguments_,
        input_schema: source.definition.inputSchema,
        keywords,
      }
    })
    .toSorted((a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name))
}

export function manifest(sources: ReadonlyArray<Source>): ReadonlyArray<ManifestLine> {
  const servers = new Map<string, Set<string>>()
  for (const source of sources) {
    const categories = servers.get(source.server) ?? new Set<string>()
    categories.add(category(source))
    servers.set(source.server, categories)
  }
  return [...servers]
    .map(([server, categories]) => ({ server, categories: [...categories].sort() }))
    .toSorted((a, b) => a.server.localeCompare(b.server))
}

export function externalServer(name: string): string {
  const separator = name.search(/[_-]/)
  return separator > 0 ? name.slice(0, separator) : "external"
}

function category(source: Source) {
  if (source.server === "core") return CORE_CATEGORIES[source.definition.name] ?? "other"
  const tokens = words(source.definition.name)
  if (tokens[0] === source.server.toLowerCase()) tokens.shift()
  const meaningful = tokens.filter((token) => !GENERIC_ACTIONS.has(token))
  return meaningful.slice(0, 2).join(" ") || "tools"
}

function words(value: string) {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

function schemaRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
