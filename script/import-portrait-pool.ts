#!/usr/bin/env bun

import path from "node:path"

const sourceDirectory = path.resolve(process.argv[2] ?? path.join(import.meta.dir, "../../doc/gfx/avatars2"))
const destinationDirectory = path.resolve(
  process.argv[3] ?? path.join(import.meta.dir, "../packages/app/public/assets/agents/portraits/pool"),
)

const columnOffsets = [32, 345, 659, 972]
const rowBounds = [
  [0, 251, 484, 728, 954, 1254],
  [0, 244, 470, 698, 936, 1254],
  [0, 250, 484, 718, 954, 1254],
  [0, 250, 483, 718, 954, 1254],
  [0, 250, 483, 718, 954, 1254],
] as const

await Bun.$`mkdir -p ${destinationDirectory}`

for (const [sheetIndex, bounds] of rowBounds.entries()) {
  const source = path.join(sourceDirectory, `sheet${String(sheetIndex + 1).padStart(2, "0")}.png`)
  for (let row = 0; row < 5; row++) {
    const y = bounds[row]
    const nextY = bounds[row + 1]
    if (y === undefined || nextY === undefined)
      throw new Error(`Missing row bounds for sheet ${sheetIndex + 1}, row ${row}`)
    const height = nextY - y
    for (let column = 0; column < columnOffsets.length; column++) {
      const slot = sheetIndex * 20 + row * 4 + column
      const destination = path.join(destinationDirectory, `avatar-${String(slot).padStart(3, "0")}.webp`)
      await Bun.$`magick ${source} -crop ${`250x${height}+${columnOffsets[column]}+${y}`} +repage -resize 250x250! -quality 98 ${destination}`
    }
  }
}
