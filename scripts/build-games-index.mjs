/**
 * build-games-index.mjs
 *
 * This script reads every .pgn file inside the repo's `games/` folder and
 * writes them into one JSON file at `public/games.json`. The app downloads
 * that JSON file when it loads and copies any new games into the in-browser
 * game database, so every game you commit shows up on every device.
 *
 * It runs automatically before `npm run dev` and `npm run build` (see the
 * "predev" and "prebuild" scripts in package.json), so you never need to run
 * it by hand. Netlify runs it on every deploy for the same reason.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the repo root, worked out from this script's location. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Folder where you drop your .pgn files. */
const GAMES_DIR = join(ROOT, "games");

/** Output file the app fetches at runtime (served from the site root). */
const OUTPUT_FILE = join(ROOT, "public", "games.json");

/**
 * Splits the text of a .pgn file into individual games.
 *
 * A single .pgn file can hold many games (Chess.com and Lichess both export
 * that way). Each game starts with an "[Event " header line, so this function
 * cuts the text right before every such line after the first one.
 *
 * @param {string} text - The full contents of one .pgn file.
 * @returns {string[]} One trimmed PGN string per game, with empty pieces removed.
 */
function splitPgnFile(text) {
  return text
    .replace(/\r\n/g, "\n") // Normalize Windows line endings so the split regex works everywhere.
    .split(/\n(?=\[Event\s)/) // Cut before each "[Event" header that starts a new game.
    .map((game) => game.trim())
    .filter((game) => game.length > 0);
}

/**
 * Builds a stable ID for a game so the app can tell whether it already
 * imported it, even if you rename or reorganize the .pgn files later.
 *
 * Chess.com and Lichess games carry a [Link "..."] or [Site "https://..."]
 * header that is unique per game, so that URL is used when present.
 * Otherwise the ID is a short hash of the game text with whitespace
 * collapsed, which stays the same as long as the game itself doesn't change.
 *
 * @param {string} pgn - The PGN text of a single game.
 * @returns {string} A string that uniquely identifies this game.
 */
function getRepoKey(pgn) {
  // Look for a [Link "url"] header first, which is what Chess.com exports.
  const link = pgn.match(/^\[Link\s+"([^"]+)"\]/m)?.[1];
  if (link) return link;

  // Lichess puts the game URL in the [Site] header instead.
  const site = pgn.match(/^\[Site\s+"(https?:\/\/[^"]+)"\]/m)?.[1];
  if (site) return site;

  // No URL available, so fall back to a hash of the normalized game text.
  const normalized = pgn.replace(/\s+/g, " ").trim();
  return "sha1:" + createHash("sha1").update(normalized).digest("hex");
}

/**
 * Main entry point: collects every game, removes duplicates, and writes the
 * JSON file. If the games folder is missing it writes an empty list so the
 * app still builds and runs.
 */
function main() {
  /** @type {{ repoKey: string, file: string, pgn: string }[]} */
  const games = [];

  /** Keys already added, so the same game in two files only appears once. */
  const seen = new Set();

  let files = [];
  try {
    // Only pick up .pgn files, sorted so the output order is predictable.
    files = readdirSync(GAMES_DIR)
      .filter((name) => name.toLowerCase().endsWith(".pgn"))
      .sort();
  } catch {
    console.warn("[games] No games/ folder found, writing an empty list.");
  }

  for (const file of files) {
    const text = readFileSync(join(GAMES_DIR, file), "utf8");

    for (const pgn of splitPgnFile(text)) {
      const repoKey = getRepoKey(pgn);
      if (seen.has(repoKey)) continue; // Skip duplicates across files.
      seen.add(repoKey);
      games.push({ repoKey, file, pgn });
    }
  }

  // Make sure public/ exists, then write the JSON the app will fetch.
  mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
  writeFileSync(OUTPUT_FILE, JSON.stringify(games, null, 2));

  console.log(
    `[games] Wrote ${games.length} game(s) from ${files.length} file(s) to public/games.json`
  );
}

main();
