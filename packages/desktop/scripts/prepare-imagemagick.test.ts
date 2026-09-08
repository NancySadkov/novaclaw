import { expect, test } from "bun:test"
import {
  IMAGEMAGICK_ARCHIVE,
  IMAGEMAGICK_SHA256,
  IMAGEMAGICK_SUPPLY_ARCHIVE,
  IMAGEMAGICK_VERSION,
  resolveImageMagickArchive,
} from "./prepare-imagemagick"

test("pins ImageMagick to the repository supply baseline", () => {
  expect(IMAGEMAGICK_VERSION).toBe("7.1.2-29")
  expect(IMAGEMAGICK_ARCHIVE).toBe("ImageMagick-7.1.2-29-portable-Q16-x64.7z")
  expect(IMAGEMAGICK_SHA256).toBe("4715072c158c46bbdc3e6971817e92ed43fca7c93142cad142ee42c603baaac1")
  expect(IMAGEMAGICK_SUPPLY_ARCHIVE.replaceAll("\\", "/")).toEndWith("/supply/ImageMagick-7.1.2-29-portable-Q16-x64.7z")
  expect(resolveImageMagickArchive(undefined)).toBe(IMAGEMAGICK_SUPPLY_ARCHIVE)
  expect(resolveImageMagickArchive("./explicit-imagemagick.7z")).toEndWith("explicit-imagemagick.7z")
})
