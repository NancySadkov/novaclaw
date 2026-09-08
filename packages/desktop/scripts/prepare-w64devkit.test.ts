import { expect, test } from "bun:test"
import {
  resolveW64devkitArchive,
  resolveW64devkitSupplySource,
  W64DEVKIT_ARCHIVE,
  W64DEVKIT_SHA256,
  W64DEVKIT_SOURCE_ARCHIVE,
  W64DEVKIT_SOURCE_SHA256,
  W64DEVKIT_SUPPLY_ARCHIVE,
  W64DEVKIT_SUPPLY_SOURCE,
  W64DEVKIT_VERSION,
} from "./prepare-w64devkit"

test("pins both the embedded Windows archive and its exact corresponding source", () => {
  expect(W64DEVKIT_VERSION).toBe("2.9.0")
  expect(W64DEVKIT_ARCHIVE).toBe("w64devkit-x64-2.9.0.7z.exe")
  expect(W64DEVKIT_SHA256).toMatch(/^[0-9a-f]{64}$/)
  expect(W64DEVKIT_SUPPLY_ARCHIVE.replaceAll("\\", "/")).toEndWith("/supply/w64devkit-x64-2.9.0.7z.exe")
  expect(resolveW64devkitArchive(undefined)).toBe(W64DEVKIT_SUPPLY_ARCHIVE)
  expect(resolveW64devkitArchive("./explicit-runtime.exe")).toEndWith("explicit-runtime.exe")
  expect(W64DEVKIT_SOURCE_ARCHIVE).toBe("source.tar")
  expect(W64DEVKIT_SOURCE_SHA256).toMatch(/^[0-9a-f]{64}$/)
  expect(W64DEVKIT_SUPPLY_SOURCE.replaceAll("\\", "/")).toEndWith("/supply/w64devkit-2.9.0-source.tar")
  expect(resolveW64devkitSupplySource(undefined)).toBe(W64DEVKIT_SUPPLY_SOURCE)
  expect(resolveW64devkitSupplySource("./explicit-source.tar")).toEndWith("explicit-source.tar")
})
