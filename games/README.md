# My games

Drop `.pgn` files in this folder and commit them. Each deploy bundles every game here into the site, and the app copies any new ones into the Database page the next time you open it, on any device.

A file can hold one game or many (a Chess.com or Lichess multi-game export works as is). Naming files like `2026-10-26-opponent.pgn` keeps the folder sorted by date, but the name doesn't matter to the app.

Games are matched by their Chess.com or Lichess link, so renaming a file or committing the same game twice won't create duplicates.

New rapid and daily games are also pulled from Chess.com automatically once a day by the "Fetch Chess.com games" workflow (`.github/workflows/fetch-games.yml`), which you can run by hand from the repo's Actions tab.
