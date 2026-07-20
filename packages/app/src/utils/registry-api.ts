import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

// Raw-fetch helpers for the Registry app's /registry endpoints (the Regedit-style database
// editor, Developer mode). NOT in the generated SDK (golden rule: never hand-edit
// packages/sdk/**/gen/**) — plain fetch with the createSdkForServer auth recipe, exactly
// like fs-api.ts.

export interface RegistryTable {
  readonly name: string
  readonly rowCount: number
}

export interface RegistryRow {
  readonly rowid: number
  readonly values: Record<string, unknown>
}

export interface RegistryPage {
  readonly table: string
  readonly columns: readonly string[]
  readonly rowCount: number
  readonly rows: readonly RegistryRow[]
}

function headersFor(server: ServerConnection.HttpBase): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(server.password
      ? { Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}` }
      : {}),
  }
}

async function call<T>(
  server: ServerConnection.HttpBase,
  method: "GET" | "POST",
  route: string,
  directory: string,
  body?: unknown,
  query?: Record<string, string>,
): Promise<T> {
  const url = new URL(route, server.url.endsWith("/") ? server.url : `${server.url}/`)
  url.searchParams.set("directory", directory)
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value)
  const res = await fetch(url, {
    method,
    headers: headersFor(server),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new Error(`${method} ${route} failed: ${res.status} ${await res.text().catch(() => "")}`)
  return (await res.json()) as T
}

export function registryTables(server: ServerConnection.HttpBase, input: { directory: string }) {
  return call<RegistryTable[]>(server, "GET", "registry/tables", input.directory)
}

export function registryRows(
  server: ServerConnection.HttpBase,
  input: { directory: string; table: string; limit?: number; offset?: number },
) {
  return call<RegistryPage>(server, "GET", "registry/rows", input.directory, undefined, {
    table: input.table,
    ...(input.limit !== undefined ? { limit: String(input.limit) } : {}),
    ...(input.offset !== undefined ? { offset: String(input.offset) } : {}),
  })
}

export function registryUpdateRow(
  server: ServerConnection.HttpBase,
  input: { directory: string; table: string; rowid: number; values: Record<string, unknown> },
) {
  return call<boolean>(server, "POST", "registry/row/update", input.directory, {
    table: input.table,
    rowid: input.rowid,
    values: input.values,
  })
}

export function registryInsertRow(
  server: ServerConnection.HttpBase,
  input: { directory: string; table: string; values: Record<string, unknown> },
) {
  return call<boolean>(server, "POST", "registry/row/insert", input.directory, {
    table: input.table,
    values: input.values,
  })
}

export function registryDeleteRow(
  server: ServerConnection.HttpBase,
  input: { directory: string; table: string; rowid: number },
) {
  return call<boolean>(server, "POST", "registry/row/delete", input.directory, {
    table: input.table,
    rowid: input.rowid,
  })
}
