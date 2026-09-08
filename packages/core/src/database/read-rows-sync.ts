import { createRequire } from "node:module"

type Row = Record<string, unknown>
type Database = {
  prepare: (query: string) => { all: () => Row[] }
  close: () => void
}
/**
 * The boot-time readers are the one database operation the crash seam needs. Keep this leaf free of
 * `#sqlite`: TypeScript otherwise selects Bun's conditional leg while checking Electron's Node main
 * process. The runtime selects the matching built-in without pulling either driver's full Effect
 * layer into this small maintenance-plane path.
 */
function openDatabase(filename: string): Database {
  const require = createRequire(import.meta.url)
  if (process.versions.bun === undefined) {
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (filename: string, options: { readOnly: boolean }) => Database
    }
    return new DatabaseSync(filename, { readOnly: true })
  }
  const { Database } = require("bun:sqlite") as {
    Database: new (filename: string, options: { readonly: boolean }) => Database
  }
  return new Database(filename, { readonly: true })
}

export function readRowsSync(filename: string, query: string): Row[] | undefined {
  try {
    const db = openDatabase(filename)
    try {
      return db.prepare(query).all()
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}
