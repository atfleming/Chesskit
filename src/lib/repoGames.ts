/**
 * repoGames.ts
 *
 * Copies games from the repo's `games/` folder into the browser's game
 * database. At build time, scripts/build-games-index.mjs bundles those .pgn
 * files into `/games.json`; this module downloads that file and adds any game
 * the browser hasn't seen yet, so committed games appear on every device.
 */

import { Chess } from "chess.js";
import { IDBPDatabase } from "idb";
import { formatGameToDatabase } from "@/lib/chess";
import { Game } from "@/types/game";

/** Shape of each entry inside /games.json, matching what the build script writes. */
interface RepoGameEntry {
  /** Stable unique ID (game URL or content hash) used to avoid duplicate imports. */
  repoKey: string;
  /** Name of the .pgn file the game came from, kept for debugging. */
  file: string;
  /** Raw PGN text of the game. */
  pgn: string;
}

/**
 * Minimal database type this module needs: a store called "games" that holds
 * Game records keyed by number. Kept loose so it works with the schema type
 * declared inside useGameDatabase without importing it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GamesDb = IDBPDatabase<any>;

/**
 * Promise for the sync that is currently running or already finished.
 * Many components call useGameDatabase at once, so this guard makes sure the
 * download and import happen only once per page load.
 */
let syncPromise: Promise<number> | null = null;

/**
 * Imports any repo games that aren't in the browser database yet.
 *
 * It is safe to call repeatedly: after the first call it returns the same
 * promise instead of running again.
 *
 * @param db - The open IndexedDB connection from useGameDatabase.
 * @returns How many new games were added (0 when everything was already there).
 */
export function syncRepoGames(db: GamesDb): Promise<number> {
  if (!syncPromise) {
    syncPromise = runSync(db).catch((error) => {
      // A failed sync should never break the app, so log it and report 0 added.
      console.warn("[games] Could not sync repo games:", error);
      return 0;
    });
  }
  return syncPromise;
}

/**
 * Does the actual work behind syncRepoGames.
 *
 * Steps: download /games.json, collect the repoKeys already stored in the
 * database, then parse and add every game whose key is missing.
 *
 * @param db - The open IndexedDB connection.
 * @returns The number of games added.
 */
async function runSync(db: GamesDb): Promise<number> {
  // "no-cache" makes the browser check for a newer file after each deploy.
  const response = await fetch("/games.json", { cache: "no-cache" });
  if (!response.ok) return 0; // No file means no repo games to import.

  const entries: RepoGameEntry[] = await response.json();

  // Build a set of keys for repo games already saved in this browser.
  const existing: Game[] = await db.getAll("games");
  const knownKeys = new Set(
    existing.map((game) => game.repoKey).filter((key): key is string => !!key)
  );

  let added = 0;

  for (const entry of entries) {
    if (knownKeys.has(entry.repoKey)) continue; // Already imported earlier.

    try {
      // Parse with chess.js so a broken PGN is caught here instead of later.
      const chess = new Chess();
      chess.loadPgn(entry.pgn);

      // Reuse Chesskit's own formatter so these rows match manually added games,
      // then tag the row with its repoKey so it is never imported twice.
      const record = { ...formatGameToDatabase(chess), repoKey: entry.repoKey };
      await db.add("games", record as Game);

      knownKeys.add(entry.repoKey);
      added++;
    } catch (error) {
      // Skip a bad game but keep importing the rest.
      console.warn(`[games] Skipped an invalid game in ${entry.file}:`, error);
    }
  }

  return added;
}
