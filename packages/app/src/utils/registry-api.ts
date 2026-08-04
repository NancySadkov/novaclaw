import type { ServerConnection } from "@/context/server"
import { instanceFetch } from "@/utils/instance-fetch"

// The Registry app's /registry endpoints (the Regedit-style database editor, Developer mode).
//
// ⚠️ Base URL, auth, and fault decoding live in `utils/instance-fetch.ts`.

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

const call = <T>(
  server: ServerConnection.HttpBase,
  method: "GET" | "POST",
  route: string,
  directory: string,
  body?: unknown,
  query?: Record<string, string | undefined>,
): Promise<T> => instanceFetch<T>(server, { method, route, directory, body, query })

export function registryTables(server: ServerConnection.HttpBase, input: { directory: string }) {
  return call<RegistryTable[]>(server, "GET", "registry/tables", input.directory)
}

export function registryRows(
  server: ServerConnection.HttpBase,
  input: { directory: string; table: string; limit?: number; offset?: number },
) {
  return call<RegistryPage>(server, "GET", "registry/rows", input.directory, undefined, {
    table: input.table,
    limit: input.limit === undefined ? undefined : String(input.limit),
    offset: input.offset === undefined ? undefined : String(input.offset),
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
