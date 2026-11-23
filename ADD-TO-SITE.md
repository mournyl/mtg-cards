# Adding the tier lists and deck tools to mournyl mtg

This folder mirrors your repo. Copy it over `mournyl-mtg` and every file lands where it belongs.

## What's new

| Path | |
|---|---|
| `public/tiers/` | Tier list hub and every role list (`/tiers/#ramp`, `/tiers/#ramp/green/rocks`, `/tiers/#removal/id-ub`) |
| `public/deck/` | Deck checker |
| `public/build/` | Slot finder |
| `public/assets/` | Shared styles, scripts and mana symbols for the new pages |
| `public/data/` | Card index (`cards.json`) and tier lookup (`tier-index.json`) |
| `public/counterspells/`, `public/saved/`, `public/tiers/<role>/` | Short pages that forward old and friendly addresses |
| `migrations/0002_decks_feedback.sql` | New D1 tables: decks, check history, tier feedback, Spellbook cache, rate limits |
| `tools/tiers/` | The build that makes the tier data, plus the hand reviews (see its README) |
| `tests/` | Deck logic tests, Worker API tests, browser checks |
| `.github/workflows/refresh-tiers.yml` | Weekly rebuild of the tier data |

## Changed files

| Path | Change |
|---|---|
| `public/index.html` | Card search: tier badges, a Tier filter, Sort by tier, tiers and better options in the card window, Suggest a tier, links to the new pages, a Decks tab under Saved, Check a list as a deck. Scryfall calls now wait 550 ms between requests (its limit is 2 a second). |
| `src/worker.js` | New routes: `/api/decks` (+ `/:id`, `/:id/checks`), `/api/feedback`, `/api/spellbook`. Your existing routes are unchanged. |
| `schema.sql` | The new tables appended, for fresh installs. |
| `.gitignore` | Ignores the build reports. |

`wrangler.toml` doesn't change: `run_worker_first = ["/api/*"]` already covers the new routes.

## Steps

1. Copy the folder over your repo.
2. Create the new tables once:
   ```
   npx wrangler d1 execute mournyl-mtg --remote --file=migrations/0002_decks_feedback.sql
   ```
3. Optional: to read the "Suggest a tier" queue at `/api/feedback`, add your username to `wrangler.toml`:
   ```
   [vars]
   ADMINS = "your-username"
   ```
   You can also read it straight from D1:
   `npx wrangler d1 execute mournyl-mtg --remote --command "SELECT card, role, tier, suggested, note FROM tier_feedback WHERE status = 'open'"`
4. Commit and push. Your GitHub deploy picks it up like any other push.
5. In GitHub, open Actions → Refresh tier data → Run workflow once to check it works. It runs every Monday after that. If its push step fails with a 403, allow write access under Settings → Actions → General → Workflow permissions.

## Checking it

```
node --test tests/core.test.mjs      # deck logic against the real data
node --test tests/worker.test.mjs    # API routes (Node 22.13 or newer, uses node:sqlite)
python3 -m http.server 8777 --directory public &
node tests/pages.check.cjs http://127.0.0.1:8777 shots   # browser checks (needs Playwright)
```

## How the pieces talk

* The tier pages, deck checker and slot finder read only the site's own files, so a 100-card check costs no Scryfall requests. Scryfall is asked only for images and prices of cards on screen, one request every 550 ms.
* Commander Spellbook is called from the Worker (`/api/spellbook`), cached in D1 for a week per card list. If Spellbook is down, the deck checker links to Find My Combos instead.
* Saved decks use your existing accounts. Logged out, decks save in that browser only.
* Feedback and Spellbook checks are open to anyone and limited per IP (20 feedback and 40 checks an hour).
