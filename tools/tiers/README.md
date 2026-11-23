# Tier list build

Builds every tier list, the hub summary and the card index from the Forge card database.

```
python3 tools/tiers/build.py <forge>/forge-gui/res --out public
```

`<forge>` is a checkout of https://github.com/Card-Forge/forge (only `forge-gui/res/cardsfolder`, `editions` and `formats` are read). The weekly GitHub Action does this for you.

## Files

| File | What it is |
|---|---|
| `pool.py` | The Commander card pool: every card with a paper printing released by today. Banned cards stay in, flagged, so the deck checker can catch them. |
| `roles.py` | The detectors: which cards do each job, which sub-list they belong to, and a first-pass score and reason. |
| `reviews/<role>.tsv` | Hand reviews. They always win over the detectors. |
| `gamechangers.txt` | The Game Changers list. Update it when Wizards changes the list. |
| `edhrec.json` | EDHREC play rates shown beside a tier. Never used in a score. |
| `out/` | Build reports (not committed): one text file per list, plus `new-candidates.txt`. |

## Reviewing a card

Add or edit a line in `reviews/<role>.tsv` (tab-separated):

```
name<TAB>sub<TAB>score<TAB>reason
Cultivate	lands	80	Two basics for three mana, one to hand; the green standard.
Mana Vortex	spells	x	Only counters itself.
```

* **name**: the full card name as Forge has it (double-faced cards use `Front // Back`). The build tells you the full name if you use the front only.
* **sub**: one of the list's sub-lists (see `ROLES` at the end of `roles.py`).
* **score**: 0–100 on the shared scale (S 90+, A 75–89, B 60–74, C 45–59, D 30–44, F under 30), or `x` to drop a card the detector picked up by mistake.
* **reason**: one line, under 20 words, naming the cost and the catch.

Score against the anchors: Counterspell (counterspells), Swords to Plowshares (removal), Cultivate (ramp), Phyrexian Arena (draw) and Wrath of God (wipes).

Cards nobody has reviewed get the detector's score squeezed into C, D or F (58 at most) and an Unreviewed badge. After each build, `out/new-candidates.txt` lists recent cards the detectors rate highly; review those first.

The build stops with an error, and the Action commits nothing, if a reviewed card is banned, missing from the pool or filed under a sub-list that doesn't exist.

## Outputs

* `public/tiers/data/<role>.json`: one entry per card (score, tier, sub-list, reason, rules text, flags, rank)
* `public/tiers/data/index.json`: the hub summary
* `public/data/cards.json`: compact index of every legal card for the deck checker and slot finder
* `public/data/tier-index.json`: card name to tiers and ranks, for the card search badges
* `public/tiers/<role>/index.html`: short pages that forward `/tiers/ramp/` to `/tiers/#ramp`
