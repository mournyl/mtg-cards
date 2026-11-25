# mournyl mtg: tier lists, My Decks and Users

## Steps

1. Decks need nothing run: the server makes its `user_decks` table the first time someone opens My decks.
   (`migrations/0002_decks.sql` does the same thing up front if you'd rather.)
2. Save the Magic card back as `public/assets/card-back.jpg`. It shows while card images load.
   Until the file is there, the pages use Scryfall's copy:
   https://backs.scryfall.io/large/0/a/0aeebaf5-8c7d-4636-9e82-8c27447861f7.jpg
3. Move `move-to-github-workflows/refresh-tiers.yml` to `.github/workflows/refresh-tiers.yml`.
4. Commit and push. Then run it once from GitHub: Actions → Refresh tier data → Run workflow.

The Users tab lists everyone's saved cards, lists and decks (read-only). Anyone can hide their profile from the menu under their name, top right; the server makes that setting's table by itself too.

Every card now carries function tags (Pinger, Switch P/T, Phasing, Tokens ...), built into `public/data/cards.json` by
`tools/tiers/tags.py`. Wrong tag on a card? Add a line to `tools/tiers/reviews/tags.tsv` (`name<TAB>+tag -tag<TAB>note`).
The weekly build writes `tools/tiers/out/tags.txt`: counts, samples per tag, and new cards that got no tag.

Decks need an account on the live site (same log in as Saved). With no server, for example when you open the files locally, they are saved in that browser instead.

## Checking it

```
python3 tests/tags_test.py
node --test tests/core.test.mjs
node --test tests/worker.test.mjs        # Node 22.13 or newer
python3 -m http.server 8777 --directory public &
node tests/pages.check.cjs http://127.0.0.1:8777 shots
```
