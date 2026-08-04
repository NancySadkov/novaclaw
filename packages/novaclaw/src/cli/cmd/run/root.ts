import { Filesystem } from "@/util/filesystem"

/** The process cwd is authoritative; PWD is inherited shell metadata and may be stale. */
export function resolveRunRoot() {
  return Filesystem.resolve(process.cwd())
}
