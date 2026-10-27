/**
 * fetch-chesscom-games.mjs
 *
 * Downloads your recent games from Chess.com's free public API and saves any
 * new rapid or daily games into the repo's `games/` folder, one file per month
 * (games/chesscom-YYYY-MM.pgn). A GitHub Action runs this once a day and
 * commits the result, and Netlify redeploys the site whenever that happens.
 *
 * Usage:
 *   node scripts/fetch-chesscom-games.mjs            # checks the last 2 months
 *   MONTHS=all node scripts/fetch-chesscom-games.mjs # checks your whole history
 *
 * Settings come from environment variables:
 *   CHESSCOM_USER  Chess.com username to pull games for (default "atf901").
 *   TIME_CLASSES   Comma-separated time classes to keep (default "rapid,daily").
 *                  Chess.com uses "bullet", "blitz", "rapid" and "daily".
 *   MONTHS         How many recent monthly archives to check, or "all".
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Chess } from "chess.js";

/** Absolute path to the repo root, based on this script's location. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Folder that holds the .pgn files the site imports. */
const GAMES_DIR = join(ROOT, "games");

/** Chess.com username whose games get downloaded. */
const USERNAME = (process.env.CHESSCOM_USER || "atf901").toLowerCase();

/** Time classes worth keeping; faster games are skipped on purpose. */
const TIME_CLASSES = new Set(
  (process.env.TIME_CLASSES || "rapid,daily")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);

/** Number of recent monthly archives to check, or Infinity for all of them. */
const MONTHS =
  process.env.MONTHS === "all" ? Infinity : Number(process.env.MONTHS || 2);

/**
 * Chess.com asks API users to send a User-Agent that identifies the app,
 * and it may block requests that don't.
 */
const HEADERS = {
  "User-Agent": `chesskit-personal-sync (github.com/atfleming/Chesskit; user ${USERNAME})`,
};

/**
 * Downloads a URL and parses the JSON body, failing loudly on HTTP errors so
 * the GitHub Action shows a red X instead of silently doing nothing.
 *
 * @param {string} url - Chess.com API endpoint to request.
 * @returns {Promise<any>} The parsed JSON response.
 */
async function getJson(url) {
  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok) {
    throw new Error(`Chess.com API returned ${response.status} for ${url}`);
  }
  return response.json();
}

/**
 * Splits a .pgn file's text into separate games. Each game begins with an
 * "[Event " header, so the text is cut right before every one after the first.
 *
 * @param {string} text - Full contents of a .pgn file.
 * @returns {string[]} One trimmed PGN string per game.
 */
function splitPgnFile(text) {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n(?=\[Event\s)/)
    .map((game) => game.trim())
    .filter(Boolean);
}

/**
 * Builds a fingerprint that identifies a game no matter how it was exported.
 *
 * The same game looks different depending on where it came from: the API adds
 * clock comments and extra headers, while the website's download button
 * leaves them out. Comparing the players, the start date and the actual list
 * of moves ignores those differences, so a game you already uploaded by hand
 * is never added a second time.
 *
 * @param {string} pgn - PGN text of a single game.
 * @returns {string | null} The fingerprint, or null if the PGN can't be parsed.
 */
function fingerprint(pgn) {
  try {
    const chess = new Chess();
    chess.loadPgn(pgn); // chess.js ignores {comments} such as clock times.
    const headers = chess.getHeaders();
    const moves = chess.history().join(" ");
    return [headers.White, headers.Black, headers.Date, moves]
      .map((part) => (part || "").toLowerCase())
      .join("|");
  } catch {
    return null; // A broken game just can't be matched; it never stops the run.
  }
}

/**
 * Reads the date of a game from its [Date "YYYY.MM.DD"] header and turns it
 * into the monthly file name the game should be saved in.
 *
 * @param {string} pgn - PGN text of a single game.
 * @returns {string} A file name such as "chesscom-2026-10.pgn".
 */
function monthFileFor(pgn) {
  const date = pgn.match(/^\[Date\s+"(\d{4})\.(\d{2})/m);
  const month = date ? `${date[1]}-${date[2]}` : "unknown-date";
  return `chesscom-${month}.pgn`;
}

/**
 * Main routine: collect fingerprints of games already in the repo, download
 * recent archives, keep new games in the wanted time classes, and append them
 * to the right monthly files.
 */
async function main() {
  // Step 1: fingerprint every game already saved so duplicates get skipped.
  const known = new Set();
  for (const file of readdirSync(GAMES_DIR)) {
    if (!file.toLowerCase().endsWith(".pgn")) continue;
    const text = readFileSync(join(GAMES_DIR, file), "utf8");
    for (const pgn of splitPgnFile(text)) {
      const key = fingerprint(pgn);
      if (key) known.add(key);
    }
  }

  // Step 2: get the list of monthly archive URLs (oldest first) and keep the newest ones.
  const { archives } = await getJson(
    `https://api.chess.com/pub/player/${USERNAME}/games/archives`
  );
  const recent = MONTHS === Infinity ? archives : archives.slice(-MONTHS);

  /** New games grouped by the monthly file they belong in. */
  const additions = new Map();
  let skippedSpeed = 0;

  // Step 3: walk each archive and pick out games that are new and slow enough.
  for (const archiveUrl of recent) {
    const { games } = await getJson(archiveUrl);

    for (const game of games) {
      // Standard chess only, so variants like Chess960 stay out.
      if (game.rules !== "chess" || !game.pgn) continue;

      // Skip bullet and blitz (or whatever TIME_CLASSES leaves out).
      if (!TIME_CLASSES.has(game.time_class)) {
        skippedSpeed++;
        continue;
      }

      const key = fingerprint(game.pgn);
      if (!key || known.has(key)) continue; // Unreadable or already saved.
      known.add(key);

      const file = monthFileFor(game.pgn);
      if (!additions.has(file)) additions.set(file, []);
      additions.get(file).push(game.pgn.trim());
    }
  }

  // Step 4: append new games to their monthly files, creating files as needed.
  let total = 0;
  for (const [file, pgns] of additions) {
    const path = join(GAMES_DIR, file);
    const existing = existsSync(path)
      ? readFileSync(path, "utf8").replace(/\r\n/g, "\n").trimEnd()
      : "";
    const combined = [existing, ...pgns].filter(Boolean).join("\n\n") + "\n";
    writeFileSync(path, combined);
    total += pgns.length;
    console.log(`[chess.com] Added ${pgns.length} game(s) to games/${file}`);
  }

  console.log(
    `[chess.com] Done: ${total} new game(s), ${skippedSpeed} skipped for time control.`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1); // Non-zero exit marks the GitHub Action run as failed.
});
