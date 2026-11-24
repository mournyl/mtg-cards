"""Build every tier list, the hub summary and the card indexes for mournyl mtg.

usage: python tools/tiers/build.py <forge res dir> [--today YYYY-MM-DD] [--out public]

Inputs
  pool.py                 Commander card pool from Forge
  roles.py                role detection, sub-lists, first-pass scores and reasons
  reviews/<role>.tsv      hand reviews: name, sub, score (0-100, or x to drop the card), reason
  gamechangers.txt        Game Changers list
Outputs (under --out, default ./public)
  tiers/data/<role>.json  one entry per card in that list
  tiers/data/index.json   hub summary: roles, sub-lists, counts, top cards
  data/cards.json         compact index of every card (deck checker, slot finder)
  data/tier-index.json    card name -> role tiers and ranks (search page badges)
  <report>/<role>.txt     plain-text report per list; <report>/new-candidates.txt lists new cards to review
Unreviewed cards are squeezed into C, D and F (58 at most) until someone reviews them.
EDHREC shares in edhrec.json are shown beside the tier as a sanity check; they never change a score.
"""
import argparse
import datetime
import json
import os
import re
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from pool import load_pool, cost_tokens, mana_value, strip_reminder  # noqa: E402
import roles as R  # noqa: E402

UNREVIEWED_CAP = 58


def unreviewed(auto):
    """First-pass scores squeeze into C, D and F until a person reviews the card (top auto score lands at 58)."""
    return min(UNREVIEWED_CAP, round(18 + auto * 0.44))
CARD_TYPES = ["Legendary", "Basic", "Snow", "World", "Kindred", "Tribal", "Artifact", "Creature", "Enchantment",
              "Instant", "Sorcery", "Planeswalker", "Land", "Battle"]


def pretty_type(t):
    w = t.split(); last = -1
    for i, x in enumerate(w):
        if x in CARD_TYPES: last = i
    return " ".join(w[:last + 1]) + (" — " + " ".join(w[last + 1:]) if w[last + 1:] else "")


def read_reviews(role):
    p = os.path.join(HERE, "reviews", role + ".tsv")
    out = {}
    if not os.path.exists(p): return out
    for n, line in enumerate(open(p, encoding="utf-8"), 1):
        line = line.rstrip("\n")
        if not line.strip() or line.startswith("#") or line.startswith("name\t"): continue
        parts = line.split("\t")
        if len(parts) < 4: raise SystemExit("%s line %d: expected name, sub, score, reason" % (p, n))
        name, sub, score, why = parts[0].strip(), parts[1].strip(), parts[2].strip(), "\t".join(parts[3:]).strip()
        if name in out: raise SystemExit("%s line %d: %s is reviewed twice" % (p, n, name))
        out[name] = dict(sub=sub, score=None if score.lower() == "x" else int(score), why=why, line=n)
    return out


STUB = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>%(title)s · mournyl mtg</title><meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0; url=%(to)s"><script>location.replace(%(js)s);</script></head>
<body style="background:#0b0b0b;color:#ececec;font:15px system-ui,sans-serif"><p><a href="%(to)s" style="color:#fff">%(title)s</a></p></body></html>
"""


def free_to_cast(card, face):
    t = " ".join(strip_reminder(f["oracle"]).lower() for f in card["faces"])
    return bool(re.search(r"rather than pay (this spell's|its) mana cost|cast this spell without paying|you may pay \{0\}|evoke—exile", t)) \
        or card["front"] == "Pact of Negation" or any(x.endswith("/P") for x in cost_tokens(face["cost"]))


def faces_out(card):
    return [dict(n=f["name"], c=cost_tokens(f["cost"]), ty=pretty_type(f["types"]), pt=f.get("pt", ""), o=f["oracle"]) for f in card["faces"]]


def type_letters(card):
    t = card["types"]; s = ""
    for k, l in (("Land", "L"), ("Creature", "C"), ("Artifact", "A"), ("Enchantment", "E"), ("Instant", "I"), ("Sorcery", "S"),
                 ("Planeswalker", "P"), ("Battle", "B")):
        if re.search(r"\b%s\b" % k, t): s += l
    if re.search(r"\bBasic\b", t): s += "Y"
    if (re.search(r"\bLegendary\b", t) and re.search(r"\bCreature\b", t)) or re.search(r"can be your commander", card["faces"][0]["oracle"], re.I): s += "K"
    if len(card["faces"]) > 1 and card.get("alt") == "Modal" and any(re.search(r"\bLand\b", f["types"]) for f in card["faces"][1:]) and "L" not in s: s += "M"
    if "L" in s and re.search(r"enters (the battlefield )?tapped\.", strip_reminder(card["faces"][0]["oracle"])) and not re.search(r"unless|if you don't|you may pay", card["faces"][0]["oracle"]): s += "T"
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("res")
    ap.add_argument("--today", default=datetime.date.today().isoformat())
    ap.add_argument("--out", default="public")
    ap.add_argument("--report", default=os.path.join(HERE, "out"))
    a = ap.parse_args()
    pool = load_pool(a.res, a.today)
    by_name = {}
    for c in pool:
        by_name[c["name"]] = c; by_name.setdefault(c["front"], c)
    os.makedirs(os.path.join(a.out, "tiers", "data"), exist_ok=True)
    os.makedirs(os.path.join(a.out, "data"), exist_ok=True)
    os.makedirs(a.report, exist_ok=True)
    edhrec = json.load(open(os.path.join(HERE, "edhrec.json"), encoding="utf-8")) if os.path.exists(os.path.join(HERE, "edhrec.json")) else {}
    recent = (datetime.date.fromisoformat(a.today) - datetime.timedelta(days=120)).isoformat()
    problems, hub, index_roles, candidates, top_gaps = [], [], defaultdict(list), [], []
    role_keys = [r[0] for r in R.ROLES]
    for key, title, desc, subs in R.ROLES:
        reviews = read_reviews(key)
        entries, seen = [], set()
        detected = {}
        for c in pool:
            if c["banned"]: continue
            r = R.DETECT[key](c)
            if r: detected[c["name"]] = r
        for name, rv in reviews.items():
            c = by_name.get(name)
            if not c: problems.append("%s: reviewed card not in the pool: %s" % (key, name)); continue
            if c["banned"]: problems.append("%s: reviewed card is banned: %s" % (key, name)); continue
            if c["name"] != name: problems.append("%s: use the full name %r for %r" % (key, c["name"], name))
        for c in pool:
            if c["banned"]: continue
            rv = reviews.get(c["name"]) or reviews.get(c["front"])
            r = detected.get(c["name"])
            if rv is None and r is None: continue
            if rv is not None and rv["score"] is None: continue
            sub = (rv and rv["sub"]) or (r and r["sub"])
            if sub not in subs:
                problems.append("%s: %s has unknown sub-list %r" % (key, c["name"], sub)); continue
            face = c["faces"][(r or {}).get("face", 0)]
            if rv and not r:
                for f in c["faces"]:
                    if not re.search(r"\bLand\b", f["types"]) or key == "lands": face = f; break
            score = rv["score"] if rv else unreviewed(r["score"])
            toks = cost_tokens(face["cost"])
            e = dict(n=c["name"], s=score, t=R.tier_of(score), sub=sub, why=rv["why"] if rv else r["why"],
                     c=toks, mv=mana_value(toks) if c.get("alt") != "Split" else c["mv"], ty=pretty_type(face["types"]),
                     clr=c["identity"], y=c["year"], o=faces_out(c))
            if rv: e["rev"] = 1
            elif c["first"] >= recent and r["score"] >= 55: candidates.append((key, r["score"], c["name"], c["first"]))
            if c["name"] in edhrec.get(key, {}): e["e"] = edhrec[key][c["name"]]
            if c["gc"]: e["gc"] = 1
            if free_to_cast(c, face): e["free"] = 1
            txt = R.text_of(face)
            if R.instant_speed(face, txt): e["inst"] = 1
            if key == "protection": e["pt"] = R.protection_types(c)
            if key == "counterspells" and ((r and r.get("soft")) or re.search(r"unless (its|that|the spell's) (controller|player)|unless they pay|unless that player", txt)): e["soft"] = 1
            entries.append(e); seen.add(c["name"])
        entries.sort(key=lambda e: (-e["s"], e["mv"], e["n"]))
        for i, e in enumerate(entries, 1): e["r"] = i
        gap = [e["n"] for e in entries[:50] if not e.get("rev")]
        if gap: top_gaps.append((key, gap))
        json.dump(entries, open(os.path.join(a.out, "tiers", "data", key + ".json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
        for e in entries: index_roles[e["n"]].append((role_keys.index(key), e["s"], list(subs).index(e["sub"]), e.get("rev", 0), e["r"]))
        tiers = Counter(e["t"] for e in entries)
        hub.append(dict(key=key, name=title, desc=desc, subs=[dict(key=k, name=v, count=sum(1 for e in entries if e["sub"] == k)) for k, v in subs.items()],
                        count=len(entries), reviewed=sum(1 for e in entries if e.get("rev")), tiers={t: tiers.get(t, 0) for t in "SABCDF"},
                        top=[dict(n=e["n"], t=e["t"], c=e["c"]) for e in entries[:5]]))
        with open(os.path.join(a.report, key + ".txt"), "w", encoding="utf-8") as fh:
            for e in entries:
                fh.write("%3d %s %-1s %-22s %-45s | %s\n" % (e["s"], "R" if e.get("rev") else "-", e["t"], e["sub"], e["n"][:45], e["why"]))
        print("%-13s %5d cards, %4d reviewed, tiers %s" % (key, len(entries), hub[-1]["reviewed"], " ".join("%s%d" % (t, tiers.get(t, 0)) for t in "SABCDF")))
    built = a.today
    # /tiers/<role>/ forwards to the tier page (/tiers/#<role>), keeping any color or sub-list after it
    for key, title, _, _ in R.ROLES:
        os.makedirs(os.path.join(a.out, "tiers", key), exist_ok=True)
        with open(os.path.join(a.out, "tiers", key, "index.html"), "w", encoding="utf-8") as fh:
            fh.write(STUB % dict(title="%s Tier List" % title, to="../#" + key, js="'../#%s' + (location.hash.length > 1 ? '/' + location.hash.slice(1) : '')" % key))
    json.dump(dict(built=built, roles=hub), open(os.path.join(a.out, "tiers", "data", "index.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    # card index for the deck checker and slot finder
    subs_of = {k: list(s) for k, _, _, s in R.ROLES}
    rows = []
    for c in pool:
        fl = R.bracket_flags(c)
        flags = ("g" if c["gc"] else "") + ("b" if c["banned"] else "") + ("m" if "mld" in fl else "") + ("x" if "extra-turn" in fl else "")
        o0 = strip_reminder(c["faces"][0]["oracle"])
        if re.search(r"a deck can have any number of cards named", o0, re.I): flags += "n"
        m = re.search(r"a deck can have up to (\w+) cards named", o0, re.I)
        if m: flags += str({"two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9}.get(m.group(1).lower(), 9))
        if re.search(r"^(partner\b|friends forever|choose a background|doctor's companion)", o0, re.I | re.M): flags += "p"
        if re.search(r"\bBackground\b", c["types"]) or re.search(r"\bTime Lord Doctor\b", c["types"]): flags += "k"
        prod = ""
        if any(re.search(r"\bLand\b", f["types"]) for f in c["faces"]): prod = R.produced_card(c)
        else:
            rr = [x for x in index_roles.get(c["name"], []) if x[0] == role_keys.index("ramp")]
            if rr: prod = R.produced(c["faces"][0]) or ""
        role_str = ",".join("%d:%d:%d:%d%s" % (ri, s, si, rk, "" if rv else "u") for ri, s, si, rv, rk in index_roles.get(c["name"], []))
        rows.append([c["name"], c["mv"], type_letters(c), c["identity"], "".join(cost_tokens(c["faces"][0]["cost"]) and [",".join(cost_tokens(c["faces"][0]["cost"]))] or []), prod, flags, role_str])
    json.dump(dict(built=built, roles=role_keys, subs=subs_of, cols=["name", "mv", "types", "identity", "cost", "produces", "flags", "roles"], rows=rows),
              open(os.path.join(a.out, "data", "cards.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    tier_index = {name: [[ri, s, si, rk, 1 if rv else 0] for ri, s, si, rv, rk in v] for name, v in index_roles.items()}
    json.dump(dict(built=built, roles=role_keys, names=[r[1] for r in R.ROLES], subs=subs_of, cards=tier_index),
              open(os.path.join(a.out, "data", "tier-index.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    candidates.sort(key=lambda x: (-x[1], x[0], x[2]))
    with open(os.path.join(a.report, "new-candidates.txt"), "w", encoding="utf-8") as fh:
        fh.write("New cards (first printed since %s) that the detectors rate highly and nobody has reviewed yet.\n" % recent)
        fh.write("Add a line to reviews/<role>.tsv for each one: name, sub, score, reason.\n\n")
        for key, gap in top_gaps: fh.write("%-13s top 50 has %d unreviewed: %s\n" % (key, len(gap), "; ".join(gap)))
        if top_gaps: fh.write("\n")
        for key, sc, name, first in candidates: fh.write("%-13s auto %3d  %s  (%s)\n" % (key, sc, name, first))
    print("new candidates to review:", len(candidates))
    for key, gap in top_gaps: print("NOTE %s: %d unreviewed card(s) in the top 50: %s" % (key, len(gap), "; ".join(gap)))
    for p in problems: print("PROBLEM", p)
    sizes = {f: os.path.getsize(os.path.join(a.out, "tiers", "data", f)) for f in os.listdir(os.path.join(a.out, "tiers", "data"))}
    print("bytes:", sum(sizes.values()), "tiers;", os.path.getsize(os.path.join(a.out, "data", "cards.json")), "cards.json;",
          os.path.getsize(os.path.join(a.out, "data", "tier-index.json")), "tier-index.json")
    if any(p.startswith(tuple(role_keys)) and ("banned" in p or "not in the pool" in p or "unknown sub" in p) for p in problems):
        sys.exit(1)


if __name__ == "__main__":
    main()
