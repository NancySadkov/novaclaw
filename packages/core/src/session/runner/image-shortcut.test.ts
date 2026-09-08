import { describe, expect, test } from "bun:test"
import { ImageShortcut } from "./image-shortcut"

// The first-ranked measured lever: treat a shell command aimed at an image as the shortcut it is.
//
// 🔴 The expensive error here is the FALSE POSITIVE, and it has already been made once. The rig's
// first version of this check flagged any bash command containing an image name and reported 17
// shortcuts in a run whose commands were `printf -- "- icon_017.png: A stylized golden bird…"` — the
// model writing out descriptions it had produced BY looking. Refusing those would break the one
// behaviour this programme is trying to encourage, so most of this file is negative cases.

describe("isImageShortcut — the true positives", () => {
  const shortcuts = [
    "xxd tmp/batch-corpus-40/icon_001.png | head -40",
    "od -A x -t x1z icon_002.png",
    "hexdump -C icon_003.jpeg",
    "base64 icon_004.png",
    "cat icon_005.png",
    "head -c 200 icon_006.webp",
    "file icon_007.png",
    "strings icon_008.png",
    "identify icon_009.png",
    "exiftool icon_010.jpg",
    "stat icon_011.png",
    "base64 icon_012.png > dump.txt",
    "xxd icon_013.png | head > bytes.txt",
    'base64 "my icon.png"',
    "xxd *.png",
  ]
  for (const command of shortcuts)
    test(`flags: ${command.slice(0, 44)}`, () => expect(ImageShortcut.isImageShortcut(command)).toBe(true))
})

describe("isImageShortcut — the false positives that matter", () => {
  // 🔴 THE MEASURED ONE. This is the command that produced 17 phantom shortcuts, and it is the model
  // doing the job correctly: writing out a description it got by LOOKING.
  test("printing a description that merely names the file is NOT a shortcut", () => {
    expect(ImageShortcut.isImageShortcut('printf -- "- icon_017.png: A stylized golden bird in flight"')).toBe(false)
  })

  // ⭐ The ledger's own second lever is "give the batch a cheaper unit of progress" — the model
  // appending its answers to a scratch file. Refusing that would punish the behaviour being sought.
  test("appending descriptions to a file is NOT a shortcut", () => {
    expect(ImageShortcut.isImageShortcut('echo "icon_020.png: a red circle" >> descriptions.md')).toBe(false)
    expect(ImageShortcut.isImageShortcut('printf "%s\\n" "icon_021.png: a blue square" > out.txt')).toBe(false)
    expect(ImageShortcut.isImageShortcut("cat notes.txt | grep icon_022.png | tee kept.md")).toBe(false)
    expect(ImageShortcut.isImageShortcut("cat notes.txt > icon_023.png")).toBe(false)
  })

  test("listing or counting the folder is NOT a shortcut — it never names bytes of one image", () => {
    expect(ImageShortcut.isImageShortcut("ls tmp/batch-corpus-40")).toBe(false)
    expect(ImageShortcut.isImageShortcut("ls -la tmp/batch-corpus-40 | wc -l")).toBe(false)
  })

  test("a byte reader aimed at a NON-image is left alone", () => {
    expect(ImageShortcut.isImageShortcut("cat package.json")).toBe(false)
    expect(ImageShortcut.isImageShortcut("head -20 README.md")).toBe(false)
    expect(ImageShortcut.isImageShortcut("xxd data.bin")).toBe(false)
  })

  test("naming an image with no byte reader at all is left alone", () => {
    expect(ImageShortcut.isImageShortcut("mv icon_030.png done/icon_030.png")).toBe(false)
    expect(ImageShortcut.isImageShortcut("rm icon_031.png")).toBe(false)
  })
})

describe("targetOf", () => {
  test("names the image so the refusal can point at it", () => {
    expect(ImageShortcut.targetOf("xxd tmp/corpus/icon_001.png | head")).toBe("tmp/corpus/icon_001.png")
  })

  test("preserves quoted-space and glob targets", () => {
    expect(ImageShortcut.targetOf('base64 "my icon.png"')).toBe("my icon.png")
    expect(ImageShortcut.targetOf("xxd *.png")).toBe("*.png")
  })

  test("answers undefined when no image is named", () => {
    expect(ImageShortcut.targetOf("ls -la")).toBeUndefined()
  })
})

describe("refusal", () => {
  // 🔴 A refusal without an alternative is just an obstacle. The measured run had 109 CORRECT steers —
  // it did not lack willingness, it was looking for a cheaper path than opening 400 files.
  test("names the tool that actually returns pixels, and the file", () => {
    const text = ImageShortcut.refusal("xxd icon_001.png")
    expect(text).toContain("read")
    expect(text).toContain("icon_001.png")
    expect(text).toContain("It was not run")
  })

  // ⚠️ States the MECHANISM, not a prohibition. "Do not use xxd on images" is routed around with
  // `od`; "a PNG is compressed data" generalises.
  test("explains why, so the model cannot route around it with another byte reader", () => {
    const text = ImageShortcut.refusal("xxd icon_001.png")
    expect(text).toContain("compressed")
    expect(text).not.toContain("do not use xxd")
  })

  test("closes the door the measured run went looking through", () => {
    expect(ImageShortcut.refusal("xxd icon_001.png")).toContain("no cheaper route")
  })

  test("names a wildcard target rather than falling back to an unspecified image", () => {
    const text = ImageShortcut.refusal("xxd *.png")
    expect(text).toContain("FILE BYTES of *.png")
    expect(text).toContain('Call read with path="*.png"')
    expect(text).not.toContain("undefined")
  })
})
