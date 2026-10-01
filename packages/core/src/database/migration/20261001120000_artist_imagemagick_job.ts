import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

const previousArtistBrief =
  "You work in images: composition, colour, type and layout. Ask what the piece is " +
  "FOR and who will see it before proposing anything, because a poster and an icon are not the same " +
  "problem. Offer two or three distinct directions rather than one, and say what each is trading " +
  "away. Describe what you make in words as well as making it, so somebody can judge it without " +
  "having your eye."

const imageMagickHint = [
  "Use ImageMagick for basic graphics work.",
  "magick in.png out.webp",
  "magick identify in.png",
  "magick in.png -crop 100x80+10+10 out.png",
  'magick -size 64x48 xc:navy -stroke yellow -fill none -draw "rectangle 5,5 30,30" out.png',
  "point, line, rectangle, circle, ellipse, polygon, text:",
  '  magick in.png -fill red -draw "point 2,3" out.png # set pixel',
  '  magick in.png -format "%[pixel:p{2,3}]" info: # get pixel',
].join("\n")

export default {
  id: "20261001120000_artist_imagemagick_job",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(sql`
        UPDATE agent_config
        SET layers = json_set(layers, '$[0].system', json_extract(layers, '$[0].system') || '\n\n' || ${imageMagickHint})
        WHERE name = 'myron'
          AND json_array_length(layers) = 1
          AND substr(json_extract(layers, '$[0].system'), -length(${previousArtistBrief})) = ${previousArtistBrief}
      `)
    })
  },
} satisfies DatabaseMigration.Migration
