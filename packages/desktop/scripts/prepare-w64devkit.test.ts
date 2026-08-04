import { expect, test } from "bun:test"
import {
  W64DEVKIT_ARCHIVE,
  W64DEVKIT_SHA256,
  W64DEVKIT_SOURCE_ARCHIVE,
  W64DEVKIT_SOURCE_SHA256,
  W64DEVKIT_SOURCE_URL,
  W64DEVKIT_URL,
  W64DEVKIT_VERSION,
} from "./prepare-w64devkit"

test("pins both the embedded Windows archive and its exact corresponding source", () => {
  expect(W64DEVKIT_VERSION).toBe("2.9.0")
  expect(W64DEVKIT_ARCHIVE).toBe("w64devkit-x64-2.9.0.7z.exe")
  expect(W64DEVKIT_URL).toContain("/releases/download/v2.9.0/")
  expect(W64DEVKIT_SHA256).toMatch(/^[0-9a-f]{64}$/)
  expect(W64DEVKIT_SOURCE_ARCHIVE).toBe("source.tar")
  expect(W64DEVKIT_SOURCE_URL).toContain("/releases/download/v2.9.0/source.tar")
  expect(W64DEVKIT_SOURCE_SHA256).toMatch(/^[0-9a-f]{64}$/)
})
