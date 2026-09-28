import { expect, test } from "bun:test"
import { startupServerKey } from "./startup-server"

test("desktop defaults to its bundled server for absent or unsupported saved selections", () => {
  for (const value of [null, undefined, "", "sidecar", "wsl:Debian", "missing", "file:///tmp/server"])
    expect(startupServerKey(value)).toBe("sidecar")
})

test("desktop retains a saved HTTP server", () => {
  for (const value of ["http://127.0.0.1:4096", "https://instance.example.test"])
    expect(startupServerKey(value)).toBe(value)
})
