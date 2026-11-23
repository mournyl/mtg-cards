"""Commander card pool from the Forge card database (github.com/Card-Forge/forge).

Reads forge-gui/res/{cardsfolder,editions,formats}. A card is in the pool when it has a printing in a
paper set type released on or before today; banned cards stay in with banned=True so the deck checker
can flag them.
"""
import datetime
import glob
import os
import re

LEGAL_SET_TYPES = {"Expansion", "Core", "Commander", "Collector_Edition", "Duel_Deck", "Draft", "Reprint",
                   "Starter", "Multiplayer", "Boxed_Set", "Promo", "Other"}
SKIP_SECTIONS = re.compile(r"token|rebalanced|other|dungeon|attraction|stickers|planes|schemes|contraption|conspir|alchemy", re.I)
NOT_CARDS = re.compile(r"\b(Plane|Phenomenon|Scheme|Vanguard|Conspiracy|Dungeon|Emblem|Attraction|Contraption|Sticker)\b")
COLOR_WORDS = {"white": "W", "blue": "U", "black": "B", "red": "R", "green": "G"}
LAND_TYPES = {"Plains": "W", "Island": "U", "Swamp": "B", "Mountain": "R", "Forest": "G"}
HERE = os.path.dirname(os.path.abspath(__file__))


def strip_reminder(text):
    return re.sub(r"\([^)]*\)", "", text or "")


def cost_tokens(cost):
    """Forge cost string ('2 W U', 'WU', 'UP', '2W', 'X R') -> tokens like '2','W','W/U','U/P','2/W','X'."""
    if not cost or cost.strip().lower() == "no cost":
        return []
    out = []
    for t in cost.split():
        if re.fullmatch(r"[WUBRGC]{2}", t): out.append(t[0] + "/" + t[1])
        elif re.fullmatch(r"[WUBRG]{2}P", t): out.append(t[0] + "/" + t[1] + "/P")
        elif re.fullmatch(r"[WUBRG]P", t): out.append(t[0] + "/P")
        elif re.fullmatch(r"2[WUBRG]", t): out.append("2/" + t[1])
        else: out.append(t)
    return out


def mana_value(tokens):
    mv = 0
    for t in tokens:
        if t.isdigit(): mv += int(t)
        elif t in ("X", "Y", "Z"): pass
        elif t.startswith("2/"): mv += 2
        else: mv += 1
    return mv


def load_prints(res):
    prints = {}
    for f in glob.glob(os.path.join(res, "editions", "*.txt")):
        meta, sect = {}, None
        for line in open(f, encoding="utf-8", errors="replace"):
            line = line.rstrip("\n")
            m = re.match(r"^\[(.+)\]\s*$", line)
            if m: sect = m.group(1).strip(); continue
            if sect == "metadata":
                if "=" in line:
                    k, v = line.split("=", 1); meta[k.strip()] = v.strip()
                continue
            if sect is None or SKIP_SECTIONS.search(sect) or not line.strip() or line.startswith("#"): continue
            mm = re.match(r"^\s*(\S+)\s+([A-Z])\s+(.+?)(\s+@.*)?$", line)
            if not mm: continue
            name = mm.group(3).split(" $")[0].split("|")[0].strip()
            prints.setdefault(name, []).append((meta.get("Code", ""), meta.get("Type", ""), meta.get("Date", "")))
    return prints


def load_banned(res):
    txt = open(os.path.join(res, "formats", "Casual", "Commander.txt"), encoding="utf-8").read()
    return {x.strip() for x in re.search(r"Banned:(.*)", txt).group(1).split(";") if x.strip()}


def load_game_changers():
    p = os.path.join(HERE, "gamechangers.txt")
    return {l.strip() for l in open(p, encoding="utf-8") if l.strip() and not l.startswith("#")}


def identity_of(faces):
    s = set()
    for f in faces:
        for t in cost_tokens(f["cost"]):
            s |= {ch for ch in t.replace("/P", "") if ch in "WUBRG"}
        for w in re.split(r"[ ,]+", (f.get("colors") or "").lower()):
            if w in COLOR_WORDS: s.add(COLOR_WORDS[w])
        for sym in re.findall(r"\{([^}]+)\}", strip_reminder(f["oracle"])):
            s |= {ch for ch in sym.replace("/P", "").replace("P", "") if ch in "WUBRG"}
        for lt, c in LAND_TYPES.items():
            if re.search(r"\b%s\b" % lt, f["types"] or ""): s.add(c)
    return "".join(c for c in "WUBRG" if c in s)


def load_pool(res, today=None):
    today = today or datetime.date.today().isoformat()
    prints, banned, gcs = load_prints(res), load_banned(res), load_game_changers()
    cards = []
    for path in glob.glob(os.path.join(res, "cardsfolder", "*", "*.txt")):
        raw = open(path, encoding="utf-8", errors="replace").read()
        faces = []
        for fr in re.split(r"\n\s*ALTERNATE\s*\n", raw):
            d = {"lines": []}
            for line in fr.splitlines():
                if ":" not in line: continue
                k, v = line.split(":", 1)
                if k in ("Name", "ManaCost", "Types", "Colors", "PT", "Loyalty", "Oracle", "AlternateMode", "Defense"): d[k] = v
                if k in ("A", "SVar", "T", "S", "R", "K"): d["lines"].append(line)
            faces.append(d)
        if not faces or "Name" not in faces[0]: continue
        front = faces[0]["Name"]
        full = " // ".join(x.get("Name", "") for x in faces) if len(faces) > 1 else front
        types0 = faces[0].get("Types", "")
        if NOT_CARDS.search(types0): continue
        pr = prints.get(full) or prints.get(front) or []
        legal_pr = [p for p in pr if p[1] in LEGAL_SET_TYPES and p[2] and p[2] <= today]
        if not legal_pr: continue
        alt = faces[0].get("AlternateMode", "")
        fl = [dict(name=x.get("Name", ""), cost=x.get("ManaCost", ""), types=x.get("Types", ""), pt=x.get("PT", ""),
                   loyalty=x.get("Loyalty", ""), colors=x.get("Colors", ""),
                   oracle=(x.get("Oracle", "") or "").replace("\\n", "\n").strip(), lines=x["lines"]) for x in faces]
        toks = [cost_tokens(f["cost"]) for f in fl]
        mv = sum(mana_value(t) for t in toks) if alt == "Split" else mana_value(toks[0])
        cards.append(dict(
            name=full, front=front, faces=fl, alt=alt, file=os.path.relpath(path, res),
            identity=identity_of(fl), mv=mv, cost=toks[0], types=types0,
            is_land=bool(re.search(r"\bLand\b", types0)),
            first=min(p[2] for p in legal_pr), year=int(min(p[2] for p in legal_pr)[:4]),
            banned=front in banned or full in banned, gc=front in gcs or full in gcs))
    cards.sort(key=lambda c: c["name"])
    return cards


if __name__ == "__main__":
    import sys
    pool = load_pool(sys.argv[1])
    print(len(pool), "cards;", sum(c["banned"] for c in pool), "banned;", sum(c["gc"] for c in pool), "game changers")
    gcs = load_game_changers()
    found = {c["front"] for c in pool if c["gc"]} | {c["name"] for c in pool if c["gc"]}
    print("game changers not found:", sorted(g for g in gcs if g not in found))
