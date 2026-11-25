"""Tag and grade every Commander-legal card with the Claude Message Batches API, outside your chat usage limits.

One request holds several cards (10 by default). For each card the model returns its tags, its downside tags,
and a graded entry for every role list it belongs in. Nothing edits the site's data or your review files until you run apply:
results land in tools/tiers/out/proposed/, and apply only appends lines for cards you haven't reviewed.

Setup (once)
  1. API key: https://platform.claude.com > Settings > API keys. Add credit under Billing.
  2. Windows:  setx ANTHROPIC_API_KEY "sk-ant-..."   then open a new terminal.
  3. Forge card data (same as the weekly build), e.g. C:\\forge\\forge-gui\\res

Commands (run from the mournyl-mtg folder)
  python tools/tiers/grade_api.py prepare C:\\forge\\forge-gui\\res --calibrate 200
        200 cards you already graded or hand-tagged, to measure agreement before spending real money
  python tools/tiers/grade_api.py prepare C:\\forge\\forge-gui\\res --no-grades --model claude-haiku-5-5
        step 1: tag every card with Haiku (about $3)
  python tools/tiers/grade_api.py prepare C:\\forge\\forge-gui\\res --only-roles --grades-only
        step 2: grade the role-list cards with Sonnet (about $15)
  python tools/tiers/grade_api.py submit     send it (shows the estimated cost, asks for "yes")
  python tools/tiers/grade_api.py status     progress
  python tools/tiers/grade_api.py fetch      download results and write the proposal files
  python tools/tiers/grade_api.py compare    agreement with your grades and hand-checked tags (add a run name for an older run)
  python tools/tiers/grade_api.py merge      combine every part into out/proposed/merged/
  python tools/tiers/grade_api.py apply      append merged proposals to reviews/*.tsv, skipping every card you already
                                             reviewed and the hand-checked tag sets (asks first; --high-only to be stricter)

prepare options
  --model claude-sonnet-5-5 (default) | claude-opus-5-5 | claude-haiku-5-5
  --per-request 10     cards per request (more = cheaper, fewer = steadier; 5-15 is sensible)
  --part K/N or K-M/N  split the pool into N equal parts by name and take part K (or parts K to M)
  --limit N            only the first N cards (after --part)
  --names FILE         only the cards named in FILE (first column), e.g. a failed.tsv to retry
  --only-roles         only cards the detectors put in at least one role list
  --skip-roles         only cards in no role list (about two thirds of the pool)
  --no-grades          tags and downsides only, no grades (with claude-haiku-5-5: about $3 for every card)
  --grades-only        grades only, no tags (with --only-roles, after the Haiku tagging run)
  --lean               skip the per-card analysis and working scores (cheaper, a little less accurate)
  --include-banned     also tag banned cards (they're never graded)
  --seed N             calibration sample
  --name NAME          results folder name (default built from the options, e.g. part1of8-sonnet)
  --force              prepare even though the last batch was never fetched

Files
  tools/tiers/rubric.md, tools/tiers/tagdefs.json   what the model is told (edit these, not the script)
  tools/tiers/out/api/      requests.jsonl, manifest.json, batch.json, results.jsonl (git-ignored)
  tools/tiers/out/proposed/<run>/   one folder per run, and merged/ after merge
    tags.tsv              name, tags, downsides, confidence: the model's tag answer per card
    tags-overrides.tsv    copy-ready lines for reviews/tags.tsv: +tag/-tag against what the site shows today
    tags-new.tsv          tags the site can't show yet (new tags and downsides), for when it can
    <role>.tsv            copy-ready lines for reviews/<role>.tsv: name, sub, score, reason
    <role>.details.tsv    tier, confidence, reason, problems, low confidence first
    <role>.drop.tsv       cards the detector put in this list that the model says don't belong
    failed.tsv            cards to retry with --names
    report.txt            totals, real cost, agreement with today's tags
"""
import argparse
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(HERE, "out")
API_DIR = os.path.join(OUT, "api")
PROPOSED = os.path.join(OUT, "proposed")
API = "https://api.anthropic.com/v1/messages/batches"
VERSION = "2023-06-01"
TOOL = "record_cards"
TIERS = [("S", 90), ("A", 75), ("B", 60), ("C", 45), ("D", 30), ("F", 0)]
# USD per million tokens at batch prices: input, output, cache read, 1-hour cache write
PRICES = {"claude-sonnet-5-5": (1.0, 5.0, 0.10, 2.0), "claude-opus-5-5": (2.0, 10.0, 0.20, 4.0),
          "claude-haiku-5-5": (0.05, 0.25, 0.01, 0.10)}
OUT_PER_CARD, OUT_PER_ROLE = 55, 60     # output tokens per card (name, tags) and per graded role (score, reason), lean
NOTES_PER_CARD, NOTES_PER_ROLE = 45, 40  # extra output tokens for the analysis and the five working scores
CACHE_HIT = 0.9                         # batches cache best-effort; the test runs hit 95-97%
CHARS_PER_TOKEN = 2.25                  # measured on the test runs (card text, tables and JSON are dense)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def tier_of(score):
    return next(t for t, lo in TIERS if score >= lo)


def load_tagdefs():
    d = json.load(open(os.path.join(HERE, "tagdefs.json"), encoding="utf-8"))
    return d["tags"]


def tag_dictionary_text(defs):
    out, group = ["## Tag dictionary", "", "key: Label - what counts. Not: what doesn't. e.g. examples"], None
    for t in defs:
        if t["group"] != group:
            group = t["group"]; out += ["", "### " + group + (" (downside tags)" if group == "Downsides" else "")]
        line = "%s: %s - %s" % (t["key"], t["label"], t["definition"])
        if t.get("exclude"): line += " Not: " + t["exclude"]
        if t.get("examples"): line += " e.g. " + t["examples"]
        out.append(line)
    return "\n".join(out)


def reference_grades(roles):
    """The owner's own grades, spread evenly from best to worst in each role, shown to the model as the scale."""
    out, names = ["## Reference grades (the site owner's; match this scale)", "", "role: card | sub-list | score | reason"], set()
    for key, _, _, _ in roles:
        p = os.path.join(HERE, "reviews", key + ".tsv")
        if not os.path.exists(p): continue
        rows = []
        for line in open(p, encoding="utf-8"):
            if line.startswith("#") or line.startswith("name\t") or not line.strip(): continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 4 and parts[2].strip().isdigit():
                rows.append((int(parts[2]), parts[0].strip(), parts[1].strip(), "\t".join(parts[3:]).strip()))
        rows.sort(reverse=True)
        n = min(len(rows), max(10, min(30, len(rows) // 18)))   # more examples where you've graded a whole list
        pick = [rows[round(i * (len(rows) - 1) / max(1, n - 1))] for i in range(n)] if n else []
        for score, name, sub, why in dict.fromkeys(pick):
            out.append("%s: %s | %s | %d | %s" % (key, name, sub, score, why)); names.add(name)
    return "\n".join(out), names


def system_text(defs, roles):
    ref, _ = reference_grades(roles)
    return (open(os.path.join(HERE, "rubric.md"), encoding="utf-8").read().rstrip() + "\n\n" + ref + "\n\n" + tag_dictionary_text(defs))


CRITERIA = (("efficiency", 30), ("effect", 25), ("timing", 15), ("reliability", 15), ("fit", 15))


def tool_schema(defs, roles, notes=True, tags=True):
    """notes=True asks for a short analysis per card and five working scores per grade: about $4 more on the full
    graded run, and the test runs graded closer to yours with them (5.5 vs 7.0 points off)."""
    fn = [t["key"] for t in defs if t["group"] != "Downsides"]
    dn = [t["key"] for t in defs if t["group"] == "Downsides"]
    subs = sorted({s for _, _, _, sb in roles for s in sb})
    role = {"type": "object", "properties": {
        "role": {"type": "string", "enum": [r[0] for r in roles]},
        "sub": {"type": "string", "enum": subs}}}
    if notes:
        for k, mx in CRITERIA:
            role["properties"][k] = {"type": "integer", "minimum": 0, "maximum": mx}
    role["properties"]["score"] = {"type": "integer", "minimum": 0, "maximum": 100}
    role["properties"]["reason"] = {"type": "string", "maxLength": 140}
    role["properties"]["confidence"] = {"type": "string", "enum": ["high", "low"]}
    role["required"] = ["role", "sub"] + ([k for k, _ in CRITERIA] if notes else []) + ["score", "reason", "confidence"]
    card = {"type": "object", "properties": {
        "name": {"type": "string"},
        **({"analysis": {"type": "string", "maxLength": 160}} if notes else {}),
        **({"tags": {"type": "array", "items": {"type": "string", "enum": fn}},
            "downsides": {"type": "array", "items": {"type": "string", "enum": dn}},
            "tag_confidence": {"type": "string", "enum": ["high", "low"]}} if tags else {}),
        "roles": {"type": "array", "items": role}},
        "required": ["name"] + (["analysis"] if notes else []) + (["tags", "downsides", "tag_confidence"] if tags else []) + ["roles"]}
    return {"name": TOOL, "description": "Record tags, downsides and role grades for every card in the request.",
            "input_schema": {"type": "object", "properties": {"cards": {"type": "array", "items": card}}, "required": ["cards"]}}


def read_reviews(role):
    p = os.path.join(HERE, "reviews", role + ".tsv")
    out = {}
    if not os.path.exists(p): return out
    for line in open(p, encoding="utf-8"):
        line = line.rstrip("\n")
        if not line.strip() or line.startswith("#") or line.startswith("name\t"): continue
        parts = line.split("\t")
        if len(parts) < 4: continue
        s = parts[2].strip()
        out[parts[0].strip()] = dict(sub=parts[1].strip(), score=None if s.lower() == "x" else int(s))
    return out


def read_gold():
    gold = {}
    for fn in ("tags-gold.tsv", "tags-holdout.tsv"):
        p = os.path.join(ROOT, "tests", fn)
        if not os.path.exists(p): continue
        for line in open(p, encoding="utf-8"):
            if not line.strip() or line.startswith("#") or line.startswith("name\t"): continue
            name, _, rest = line.rstrip("\n").partition("\t")
            gold[name] = set(rest.split("\t")[0].split())
    return gold


def card_text(card, P):
    lines = []
    for f in card["faces"]:
        cost = "".join("{%s}" % t for t in P.cost_tokens(f["cost"])) or "(no mana cost)"
        lines.append("%s  %s" % (f["name"], cost))
        lines.append(f["types"] + ("  " + f["pt"] if f.get("pt") else "") + ("  Loyalty " + f["loyalty"] if f.get("loyalty") else ""))
        lines.append(P.strip_reminder(f["oracle"]).strip() or "(no rules text)")
    head = "Mana value %s" % card["mv"] + ("; layout %s" % card["alt"] if card.get("alt") else "") + ("; Game Changer (a bracket flag, never a penalty)" if card.get("gc") else "")
    return head + "\n" + "\n".join(lines)


def http(method, url, body=None, raw=False):
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key: raise SystemExit("Set ANTHROPIC_API_KEY first (see the top of this file).")
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "x-api-key": key, "anthropic-version": VERSION, "content-type": "application/json"})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                payload = r.read()
                return payload if raw else json.loads(payload)
        except urllib.error.HTTPError as e:
            msg = e.read().decode("utf-8", "replace")
            if e.code in (429, 500, 502, 503, 529) and attempt < 5:
                time.sleep(10 * (attempt + 1)); continue
            raise SystemExit("API error %s: %s" % (e.code, msg[:600]))
        except urllib.error.URLError as e:
            if attempt < 5: time.sleep(10 * (attempt + 1)); continue
            raise SystemExit("Network error: %s" % e)


def estimate(requests, model):
    if not requests: return 0.0
    pin, pout, pread, pwrite = PRICES[model]
    p0 = requests[0]["params"]
    prefix = (len(p0["system"][0]["text"]) + len(json.dumps(p0["tools"]))) / CHARS_PER_TOKEN
    n = len(requests)
    user = sum(len(r["params"]["messages"][0]["content"]) for r in requests) / CHARS_PER_TOKEN
    cards = sum(r["_cards"] for r in requests)
    roles = sum(r["_roles"] for r in requests)
    notes = "analysis" in json.dumps(p0["tools"])
    has_tags = '"tag_confidence"' in json.dumps(p0["tools"])
    out = cards * ((OUT_PER_CARD if has_tags else 20) + NOTES_PER_CARD * notes) + roles * (OUT_PER_ROLE + NOTES_PER_ROLE * notes)
    return (prefix * n * CACHE_HIT * pread + prefix * n * (1 - CACHE_HIT) * pwrite + user * pin + out * pout) / 1e6


# ---------------------------------------------------------------- prepare
def cmd_prepare(a):
    if a.no_grades and a.grades_only: raise SystemExit("--no-grades and --grades-only can't go together.")
    mode = "tags" if a.no_grades else "grades" if a.grades_only else "both"
    bp = os.path.join(API_DIR, "batch.json")
    if os.path.exists(bp) and not json.load(open(bp)).get("fetched") and not a.force:
        raise SystemExit("The last batch hasn't been fetched yet. Run fetch first (or add --force to throw it away).")
    import pool as P
    import roles as R
    import tags as TG
    defs = load_tagdefs()
    pool = P.load_pool(a.res)
    print("Loaded %d cards from Forge." % len(pool))

    def produced_of(c):
        return R.produced_card(c) if any(re.search(r"\bLand\b", f["types"]) for f in c["faces"]) else ""
    site_tags = TG.tag_pool(pool, produced_of)            # what the site shows today (detector + reviews/tags.tsv)
    guesses = {}
    for c in pool:
        g = []
        if not c["banned"]:
            for key, _, _, _ in R.ROLES:
                r = R.DETECT[key](c)
                if r: g.append((key, r.get("sub")))
        guesses[c["name"]] = g

    cards = [c for c in pool if a.include_banned or not c["banned"]]
    if a.only_roles: cards = [c for c in cards if guesses[c["name"]]]
    if a.skip_roles: cards = [c for c in cards if not guesses[c["name"]]]
    if a.calibrate:
        reviewed = set()
        for key, _, _, _ in R.ROLES:
            reviewed |= {n for n, rv in read_reviews(key).items() if rv["score"] is not None}
        reviewed -= reference_grades(R.ROLES)[1]          # the model sees these as examples, so they can't test it
        rub = open(os.path.join(HERE, "rubric.md"), encoding="utf-8").read()
        reviewed = {n for n in reviewed if not any(re.search(r"(?<![\w'])%s(?![\w'])" % re.escape(x), rub)
                                                   for x in {n, n.split(" // ")[0]})}   # nor the rubric's ladder cards
        gold = set(read_gold())
        by = {}
        for c in cards: by[c["name"]] = c; by.setdefault(c["front"], c)
        rng = random.Random(a.seed)
        rv = sorted({by[n]["name"] for n in reviewed if n in by}); gd = sorted({by[n]["name"] for n in gold if n in by})
        rng.shuffle(rv); rng.shuffle(gd)
        half = a.calibrate // 2
        pick = list(dict.fromkeys(rv[:half] + gd[:a.calibrate - half]))
        cards = [by[n] for n in pick]
    else:
        if a.names:
            want = {l.split("\t")[0].strip() for l in open(a.names, encoding="utf-8") if l.strip() and not l.startswith("#")}
            cards = [c for c in cards if c["name"] in want or c["front"] in want]
        if a.part:
            m = re.fullmatch(r"(\d+)(?:-(\d+))?/(\d+)", a.part)
            if not m: raise SystemExit("--part looks like 1/4 or 2-4/4")
            k, k2, n = int(m.group(1)), int(m.group(2) or m.group(1)), int(m.group(3))
            if not 1 <= k <= k2 <= n: raise SystemExit("--part looks like 1/4 or 2-4/4")
            size = -(-len(cards) // n)
            cards = cards[(k - 1) * size:k2 * size]
        if a.limit: cards = cards[:a.limit]
        if not a.redo and os.path.isdir(PROPOSED):
            want = {"tags": {"tags"}, "grades": {"grades"}, "both": {"tags", "grades"}}[mode]
            done = defaultdict(set)                          # card -> what earlier runs already gave it
            for d in os.listdir(PROPOSED):
                if d.startswith("calibration") or d == "merged": continue
                p = os.path.join(PROPOSED, d, "answered.tsv")
                if not os.path.exists(p): continue
                got = {"tags": {"tags"}, "grades": {"grades"}, "both": {"tags", "grades"}}[open(p, encoding="utf-8").readline().split()[-1]]
                for n in data_lines(p): done[n] |= got
            before = len(cards)
            cards = [c for c in cards if not want <= done.get(c["name"], set())]
            if before - len(cards): print("Skipping %d cards that already have these results (add --redo to do them again)." % (before - len(cards)))
    if not cards: raise SystemExit("No cards selected.")

    system = system_text(defs, R.ROLES)
    tool = tool_schema(defs, R.ROLES, notes=not (a.lean or a.no_grades), tags=not a.grades_only)
    roles_line = "Role lists (role: what it's for; sub-lists):\n" + "\n".join(
        "  %s: %s %s" % (k, d, "; ".join("%s = %s" % kv for kv in sb.items())) for k, _, d, sb in R.ROLES)
    requests, manifest = [], {}
    for i in range(0, len(cards), a.per_request):
        chunk = cards[i:i + a.per_request]
        cid = "r%06d" % (i // a.per_request)
        if a.grades_only:
            parts = ["Grade these %d cards; don't tag them (the tool has no tag fields). Answer only by calling record_cards once, with exactly one entry per card, in this order, with the exact name.\n\n%s"
                     % (len(chunk), roles_line)]
        elif a.no_grades:
            parts = ["Tag these %d cards; don't grade them: give every card an empty roles list. Answer only by calling "
                     "record_cards once, with exactly one entry per card, in this order, with the exact name." % len(chunk)]
        else:
            parts = ["Tag and grade these %d cards. Answer only by calling record_cards once, with exactly one entry per card, in this order, with the exact name.\n\n%s"
                     % (len(chunk), roles_line)]
        for j, c in enumerate(chunk, 1):
            g = guesses[c["name"]]
            hint = ", ".join("%s/%s" % x for x in g) if g else "none"
            note = " (banned in Commander: tag it, don't grade it)" if c["banned"] else ""
            parts.append("### Card %d: %s%s\nFirst-pass role guesses: %s\n%s" % (j, c["name"], note, hint, card_text(c, P)))
        user = "\n\n".join(parts)
        requests.append({"custom_id": cid, "_cards": len(chunk), "_roles": 0 if a.no_grades else sum(len(guesses[c["name"]]) for c in chunk),
                         "params": {"model": a.model, "max_tokens": 600 * len(chunk) + 400,
                                    "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral", "ttl": "1h"}}],
                                    "tools": [tool], "tool_choice": {"type": "auto"},   # newer models refuse a forced tool; the rubric says to call it
                                    "messages": [{"role": "user", "content": user}]}})
        manifest[cid] = [{"name": c["name"], "front": c["front"], "banned": c["banned"], "site_tags": site_tags.get(c["name"], []),
                          "guesses": guesses[c["name"]]} for c in chunk]
    os.makedirs(API_DIR, exist_ok=True)
    with open(os.path.join(API_DIR, "requests.jsonl"), "w", encoding="utf-8") as fh:
        for r in requests:
            fh.write(json.dumps({k: v for k, v in r.items()}, ensure_ascii=False) + "\n")
    run = a.name or "-".join(x for x in [
        "calibration" if a.calibrate else ("part" + a.part.replace("/", "of") if a.part else (time.strftime("retry%m%d-%H%M") if a.names else "all")),
        a.model.split("-")[1], "roles" if a.only_roles and not a.grades_only else "", "tagsonly" if a.no_grades else "",
        "grades" if a.grades_only else ""] if x)
    json.dump({"model": a.model, "calibrate": bool(a.calibrate), "part": a.part, "run": run, "mode": mode, "no_grades": a.no_grades, "items": manifest,
               "prepared": time.strftime("%Y-%m-%d %H:%M")}, open(os.path.join(API_DIR, "manifest.json"), "w", encoding="utf-8"))
    if os.path.exists(bp): os.remove(bp)
    in_roles = sum(1 for c in cards if guesses[c["name"]])
    print("Prepared %d cards in %d requests (%d cards per request) with %s." % (len(cards), len(requests), a.per_request, a.model))
    print("  %d of them are in a role list today; %d are tags only." % (in_roles, len(cards) - in_roles))
    print("  Estimated cost: about $%.2f. Results will go to tools/tiers/out/proposed/%s/" % (estimate(requests, a.model), run))
    print("  Next: python tools/tiers/grade_api.py submit")


def load_requests():
    p = os.path.join(API_DIR, "requests.jsonl")
    if not os.path.exists(p): raise SystemExit("Run prepare first.")
    return [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()]


# ---------------------------------------------------------------- submit / status
def cmd_submit(a):
    reqs = load_requests()
    man = json.load(open(os.path.join(API_DIR, "manifest.json"), encoding="utf-8"))
    bp = os.path.join(API_DIR, "batch.json")
    if os.path.exists(bp) and not a.force:
        raise SystemExit("Already submitted (%s). Use status and fetch, or prepare a new batch." % ", ".join(json.load(open(bp))["ids"]))
    cards = sum(r["_cards"] for r in reqs)
    print("Sending %d cards in %d requests with %s, estimated $%.2f." % (cards, len(reqs), man["model"], estimate(reqs, man["model"])))
    if not a.yes and input("Type yes to send: ").strip().lower() != "yes": raise SystemExit("Not sent.")
    ids, chunk, size = [], [], 0
    for r in reqs + [None]:                      # stay under the 256 MB / 100,000-request batch limits
        body = {"custom_id": r["custom_id"], "params": r["params"]} if r else None
        line = len(json.dumps(body).encode()) if body else 0
        if body is None or len(chunk) >= 50000 or size + line > 200_000_000:
            if chunk:
                b = http("POST", API, {"requests": chunk})
                ids.append(b["id"]); print("  batch", b["id"], b["processing_status"])
            chunk, size = [], 0
        if body is not None: chunk.append(body); size += line
    json.dump({"ids": ids, "submitted": time.strftime("%Y-%m-%d %H:%M")}, open(bp, "w"))
    print("Submitted. Batches usually finish within an hour (24 hours at most). Check: python tools/tiers/grade_api.py status")


def batch_ids():
    bp = os.path.join(API_DIR, "batch.json")
    if not os.path.exists(bp): raise SystemExit("Nothing submitted yet.")
    return json.load(open(bp))["ids"]


def cmd_status(a):
    for bid in batch_ids():
        b = http("GET", "%s/%s" % (API, bid))
        rc = b.get("request_counts", {})
        print("%s  %s  processing %s, succeeded %s, errored %s, expired %s, canceled %s" % (
            bid, b["processing_status"], rc.get("processing"), rc.get("succeeded"), rc.get("errored"), rc.get("expired"), rc.get("canceled")))


# ---------------------------------------------------------------- fetch
def parse_result(line):
    res = line.get("result", {})
    if res.get("type") != "succeeded":
        return None, None, "%s %s" % (res.get("type"), json.dumps(res.get("error", ""))[:200])
    msg = res["message"]
    for block in msg.get("content", []):
        if block.get("type") == "tool_use" and block.get("name") == TOOL:
            cards = block["input"].get("cards", [])
            if isinstance(cards, str):                    # now and then the model sends the list as a JSON string
                try: cards = json.loads(cards)
                except ValueError: return None, msg.get("usage", {}), "reply list was unreadable text"
            if not isinstance(cards, list): return None, msg.get("usage", {}), "reply wasn't a list of cards"
            return [c for c in cards if isinstance(c, dict)], msg.get("usage", {}), None
    for block in msg.get("content", []):
        if block.get("type") == "text":
            m = re.search(r"\{.*\}", block["text"], re.S)
            if m:
                try: return json.loads(m.group(0)).get("cards", []), msg.get("usage", {}), None
                except ValueError: pass
    return None, msg.get("usage", {}), "no answer in the reply (stop reason %s)" % msg.get("stop_reason")


def grade_of(g):
    problems = []
    score = g.get("score")
    if not isinstance(score, int): problems.append("missing score"); score = 0
    if score < 0 or score > 100: problems.append("score out of range"); score = max(0, min(100, score))
    return score, problems


def norm(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def cmd_fetch(a):
    import roles as R
    man = json.load(open(os.path.join(API_DIR, "manifest.json"), encoding="utf-8"))
    defs = load_tagdefs()
    site_keys = {t["key"] for t in defs if t["status"] in ("existing", "changed")}
    fn_keys = {t["key"] for t in defs if t["group"] != "Downsides"}
    dn_keys = {t["key"] for t in defs if t["group"] == "Downsides"}
    subs_of = {r[0]: set(r[3]) for r in R.ROLES}
    if a.from_file:
        lines = [json.loads(l) for l in open(a.from_file, encoding="utf-8") if l.strip()]
    else:
        lines = []
        for bid in batch_ids():
            b = http("GET", "%s/%s" % (API, bid))
            if b["processing_status"] != "ended": raise SystemExit("Batch %s is still %s; try again later." % (bid, b["processing_status"]))
            raw = http("GET", b["results_url"], raw=True).decode("utf-8")
            lines += [json.loads(l) for l in raw.splitlines() if l.strip()]
        with open(os.path.join(API_DIR, "results.jsonl"), "w", encoding="utf-8") as fh:
            for l in lines: fh.write(json.dumps(l, ensure_ascii=False) + "\n")

    usage, failed, tag_rows, role_rows, drops = Counter(), [], [], defaultdict(list), defaultdict(list)
    mode = man.get("mode", "tags" if man.get("no_grades") else "both")
    answered = []
    added, removed = Counter(), Counter()
    for line in lines:
        items = man["items"].get(line.get("custom_id"))
        if not items: continue
        answers, u, err = parse_result(line)
        for k, v in (u or {}).items():
            if isinstance(v, int): usage[k] += v
        if err:
            failed += [(it["name"], err) for it in items]; continue
        by_name = {norm(x.get("name")): x for x in answers}
        for pos, it in enumerate(items):
            x = by_name.get(norm(it["name"])) or by_name.get(norm(it["front"]))
            if x is None and pos < len(answers) and len(answers) == len(items): x = answers[pos]   # same order, odd name
            if x is None: failed.append((it["name"], "missing from the reply")); continue
            answered.append(it["name"])
            if mode != "grades":                                  # a grades-only run must never touch tags
                tags = [t for t in dict.fromkeys(x.get("tags") or []) if t in fn_keys]
                downs = [t for t in dict.fromkeys(x.get("downsides") or []) if t in dn_keys]
                conf = x.get("tag_confidence", "low")
                tag_rows.append((it["name"], tags, downs, conf, it["site_tags"]))
                for t in set(tags) & site_keys - set(it["site_tags"]): added[t] += 1
                for t in set(it["site_tags"]) - set(tags): removed[t] += 1
            if it["banned"] or mode == "tags": continue
            graded = set()
            for g in x.get("roles") or []:
                role = g.get("role")
                if role not in subs_of: continue
                score, problems = grade_of(g)
                sub = g.get("sub")
                if sub not in subs_of[role]:
                    problems.append("sub %r isn't in %s" % (sub, role))
                    sub = dict(it["guesses"]).get(role) or sorted(subs_of[role])[0]
                graded.add(role)
                role_rows[role].append(dict(name=it["name"], sub=sub, score=score,
                    reason=re.sub(r"\s+", " ", (g.get("reason") or "").replace("\t", " ")).strip(),
                    conf=g.get("confidence", "low"), problems="; ".join(problems),
                    breakdown="/".join(str(g[k]) for k, _ in CRITERIA) if all(k in g for k, _ in CRITERIA) else ""))
            for role, sub in it["guesses"]:
                if role not in graded: drops[role].append((it["name"], sub))

    run = man.get("run", "run")
    dest = os.path.join(PROPOSED, run)
    if os.path.isdir(dest):
        for fn in os.listdir(dest): os.remove(os.path.join(dest, fn))
    os.makedirs(dest, exist_ok=True)
    stamp = "# %s, %s, %s\n" % (man["model"], run, time.strftime("%Y-%m-%d"))

    def write(fn, header, rows):
        with open(os.path.join(dest, fn), "w", encoding="utf-8") as fh:
            fh.write(stamp + header)
            for r in rows: fh.write("\t".join(str(x) for x in r) + "\n")

    with open(os.path.join(dest, "answered.tsv"), "w", encoding="utf-8") as fh:   # what this run covered, for skipping later
        fh.write("# mode %s\n" % mode + "".join(n + "\n" for n in sorted(answered)))
    ov = []
    if mode != "grades":
        write("tags.tsv", "name\ttags\tdownsides\tconfidence\n",
              [(n, " ".join(t), " ".join(d), c) for n, t, d, c, s in sorted(tag_rows)])
    for n, t, d, c, s in sorted(tag_rows):
        ch = ["+" + k for k in t if k in site_keys and k not in s] + ["-" + k for k in s if k not in t]
        if ch: ov.append((n, " ".join(ch), "api %s confidence" % c))
    if mode != "grades":
        write("tags-overrides.tsv", "# Lines for reviews/tags.tsv. Low-confidence lines are worth a look first.\n", ov)
        write("tags-new.tsv", "name\tnew tags\tdownsides\n",
          [(n, " ".join(k for k in t if k not in site_keys), " ".join(d)) for n, t, d, c, s in sorted(tag_rows)
           if [k for k in t if k not in site_keys] or d])
    for role, rows in role_rows.items():
        rows.sort(key=lambda r: (-r["score"], r["name"]))
        write(role + ".tsv", "# Lines for reviews/%s.tsv (name, sub, score, reason).\n" % role,
              [(r["name"], r["sub"], r["score"], r["reason"]) for r in rows])
        write(role + ".details.tsv", "name\tsub\tscore\ttier\tconfidence\treason\tproblems\tworking (eff/effect/timing/rel/fit)\n",
              [(r["name"], r["sub"], r["score"], tier_of(r["score"]), r["conf"], r["reason"], r["problems"], r["breakdown"])
               for r in sorted(rows, key=lambda r: (r["conf"] != "low", r["name"]))])
    for role, rows in drops.items():
        write(role + ".drop.tsv", "# The detector put these in %s; the model says they don't belong. To drop one, add: name<TAB>sub<TAB>x<TAB>reason\nname\tdetector sub\n" % role, sorted(rows))
    if failed: write("failed.tsv", "name\terror\n", sorted(failed))

    pin, pout, pread, pwrite = PRICES[man["model"]]
    cost = (usage["input_tokens"] * pin + usage["output_tokens"] * pout + usage["cache_read_input_tokens"] * pread
            + usage["cache_creation_input_tokens"] * pwrite) / 1e6
    rep = [stamp.strip("# \n"),
           "cards answered: %d, failed: %d (mode: %s)" % (len(answered), len(failed), mode),
           "tokens: input %d, output %d, cache read %d, cache write %d -> about $%.2f" % (
               usage["input_tokens"], usage["output_tokens"], usage["cache_read_input_tokens"], usage["cache_creation_input_tokens"], cost),
           "low tag confidence: %d" % sum(1 for r in tag_rows if r[3] == "low"),
           "cards with tag changes vs the site: %d (tags-overrides.tsv)" % len(ov),
           "", "graded per role (low confidence / detector guesses dropped):"]
    for key, _, _, _ in R.ROLES:
        rows = role_rows.get(key, [])
        rep.append("  %-14s %5d graded, %4d low, %4d dropped" % (key, len(rows), sum(1 for r in rows if r["conf"] == "low"), len(drops.get(key, []))))
    rep += ["", "site tags the model added most: " + ", ".join("%s %d" % kv for kv in added.most_common(12)),
            "site tags the model removed most: " + ", ".join("%s %d" % kv for kv in removed.most_common(12))]
    open(os.path.join(dest, "report.txt"), "w", encoding="utf-8").write("\n".join(rep) + "\n")
    bp = os.path.join(API_DIR, "batch.json")
    if os.path.exists(bp):
        b = json.load(open(bp)); b["fetched"] = True; json.dump(b, open(bp, "w"))
    print("\n".join(rep))
    print("\nFiles are in tools/tiers/out/proposed/%s/. Check them with: python tools/tiers/grade_api.py compare" % run)
    if failed: print("%d cards failed. Re-run just those: prepare <forge res> --names tools/tiers/out/proposed/%s/failed.tsv" % (len(failed), run))


# ---------------------------------------------------------------- compare
def cmd_compare(a):
    import roles as R
    defs = load_tagdefs()
    site_keys = {t["key"] for t in defs if t["status"] == "existing"}   # 'mill' changed meaning, so it's left out
    type_only = {"aura", "equipment", "vehicle", "saga", "planeswalker"}
    run = a.run or json.load(open(os.path.join(API_DIR, "manifest.json"), encoding="utf-8")).get("run", "run")
    src = os.path.join(PROPOSED, run)
    if not os.path.isdir(src): raise SystemExit("No results in %s. Run fetch first." % src)
    print("Run: %s" % run)
    print("Grades vs your reviews")
    rows = []
    for key, _, _, _ in R.ROLES:
        p = os.path.join(src, key + ".tsv")
        if not os.path.exists(p): continue
        mine = read_reviews(key)
        for line in open(p, encoding="utf-8"):
            if line.startswith("#") or not line.strip(): continue
            name, sub, score, _ = (line.rstrip("\n").split("\t") + [""] * 4)[:4]
            rv = mine.get(name)
            if rv and rv["score"] is not None: rows.append((key, name, int(score), rv["score"], sub == rv["sub"]))
    if rows:
        d = [abs(p - m) for _, _, p, m, _ in rows]; n = len(rows)
        print("  %d cards. Average difference %.1f points; within 5: %d%%; within 10: %d%%; same tier: %d%%; same sub-list: %d%%; bias %+.1f"
              % (n, sum(d) / n, round(100 * sum(x <= 5 for x in d) / n), round(100 * sum(x <= 10 for x in d) / n),
                 round(100 * sum(tier_of(p) == tier_of(m) for _, _, p, m, _ in rows) / n), round(100 * sum(s for *_, s in rows) / n),
                 sum(p - m for _, _, p, m, _ in rows) / n))
        print("  Biggest disagreements (model vs yours):")
        for key, name, p, m, _ in sorted(rows, key=lambda r: -abs(r[2] - r[3]))[:15]:
            print("    %-13s %-38s %3d vs %3d" % (key, name[:38], p, m))
    else:
        print("  none of the graded cards have a review of yours")
    print("\nTags vs the hand-checked tag sets (tests/tags-gold.tsv, tags-holdout.tsv)")
    gold = read_gold()
    got = {}
    p = os.path.join(src, "tags.tsv")
    for line in open(p, encoding="utf-8"):
        if line.startswith("#") or line.startswith("name\t") or not line.strip(): continue
        parts = line.rstrip("\n").split("\t")
        got[parts[0]] = set(parts[1].split())
    tp = fp = fn = 0; per = defaultdict(lambda: [0, 0, 0])
    for name, want in gold.items():
        if name not in got: continue
        want = want & site_keys - type_only; have = got[name] & site_keys - type_only
        for k in have & want: tp += 1; per[k][0] += 1
        for k in have - want: fp += 1; per[k][1] += 1
        for k in want - have: fn += 1; per[k][2] += 1
    if tp + fp + fn:
        print("  %d cards. Precision %.1f%%, recall %.1f%%" % (sum(1 for n in gold if n in got), 100 * tp / max(1, tp + fp), 100 * tp / max(1, tp + fn)))
        worst = sorted(per.items(), key=lambda kv: -(kv[1][1] + kv[1][2]))[:10]
        print("  Most disagreements by tag (right / extra / missed): " + ", ".join("%s %d/%d/%d" % (k, *v) for k, v in worst))
    else:
        print("  none of the answered cards are in the hand-checked sets")


# ---------------------------------------------------------------- merge
ROLE_KEYS = ("counterspells", "ramp", "draw", "removal", "wipes", "tutors", "protection", "gyhate", "recursion", "lands")


def cmd_merge(a):
    """Combine several runs (e.g. part1of4 .. part4of4) into out/proposed/merged/, later runs winning per card."""
    runs = a.runs or sorted(d for d in os.listdir(PROPOSED) if os.path.isdir(os.path.join(PROPOSED, d))
                            and not d.startswith("calibration") and d != "merged")
    if not runs: raise SystemExit("No runs to merge.")
    runs.sort(key=lambda d: os.path.getmtime(os.path.join(PROPOSED, d, "report.txt")) if os.path.exists(os.path.join(PROPOSED, d, "report.txt")) else 0)
    dest = os.path.join(PROPOSED, "merged")
    os.makedirs(dest, exist_ok=True)
    files, heads = defaultdict(dict), {}
    KINDS = {"tags": {"tags"}, "grades": {"grades"}, "both": {"tags", "grades"}}
    got, fails = defaultdict(set), {}                     # card -> kinds some run delivered; (card, kind) -> error
    for run in runs:
        d = os.path.join(PROPOSED, run)
        mode = "both"
        ap = os.path.join(d, "answered.tsv")
        if os.path.exists(ap):
            mode = open(ap, encoding="utf-8").readline().split()[-1]
            for n in data_lines(ap): got[n] |= KINDS[mode]
        fp = os.path.join(d, "failed.tsv")
        for line in data_lines(fp):
            name, _, err = line.partition("\t")
            for k in KINDS[mode]: fails[(name, k)] = err
        for fn in sorted(os.listdir(d)):
            if not fn.endswith(".tsv") or fn in ("answered.tsv", "failed.tsv"): continue
            for line in open(os.path.join(d, fn), encoding="utf-8"):
                if line.startswith("#") or line.startswith("name\t"):
                    h = heads.setdefault(fn, [])
                    if not line.startswith("# claude-") and line not in h: h.append(line)
                    continue
                if not line.strip(): continue
                name = line.split("\t")[0]
                files[fn][name] = line if line.endswith("\n") else line + "\n"
    still = {k: sorted((n, e) for (n, kk), e in fails.items() if kk == k and k not in got.get(n, set())) for k in ("tags", "grades")}
    for fn in os.listdir(dest): os.remove(os.path.join(dest, fn))
    for k, rows in still.items():
        if rows:
            with open(os.path.join(dest, "failed-%s.tsv" % k), "w", encoding="utf-8") as fh:
                fh.write("# cards still missing %s; retry with prepare <forge res> --names <this file> %s\nname\terror\n"
                         % (k, "--no-grades --model claude-haiku-5-5" if k == "tags" else "--grades-only"))
                fh.writelines("%s\t%s\n" % r for r in rows)
    for fn, rows in files.items():
        if not rows: continue
        with open(os.path.join(dest, fn), "w", encoding="utf-8") as fh:
            fh.write("# merged from %s, %s\n" % (", ".join(runs), time.strftime("%Y-%m-%d")) + "".join(heads.get(fn, [])))
            fh.writelines(rows[n] for n in sorted(rows))
    graded = {n for fn, rows in files.items() if fn.endswith(".tsv") and fn[:-4] in {r for r in ROLE_KEYS} for n in rows}
    print("Merged %s into tools/tiers/out/proposed/merged/: %d cards tagged, %d cards graded, %d tag fixes." % (
        ", ".join(runs), len(files.get("tags.tsv", {})), len(graded), len(files.get("tags-overrides.tsv", {}))))
    for k, rows in still.items():
        if rows: print("  %d cards still have no %s: see merged/failed-%s.tsv (it says how to retry)." % (len(rows), k, k))


# ---------------------------------------------------------------- apply
def data_lines(path):
    if not os.path.exists(path): return []
    return [l.rstrip("\n") for l in open(path, encoding="utf-8")
            if l.strip() and not l.startswith("#") and not l.startswith("name\t")]


def cmd_apply(a):
    """Append proposals to reviews/*.tsv, but only for cards you haven't reviewed yourself. Never edits a line."""
    import roles as R
    run = a.run or ("merged" if os.path.isdir(os.path.join(PROPOSED, "merged")) else
                    json.load(open(os.path.join(API_DIR, "manifest.json"), encoding="utf-8")).get("run", "run"))
    src = os.path.join(PROPOSED, run)
    if not os.path.isdir(src): raise SystemExit("No results in %s." % src)
    gold = set(read_gold())
    plan = []
    for key, _, _, _ in R.ROLES:
        rows = data_lines(os.path.join(src, key + ".tsv"))
        if not rows: continue
        conf = {l.split("\t")[0]: l.split("\t")[4] for l in data_lines(os.path.join(src, key + ".details.tsv"))}
        have = {l.split("\t")[0].strip() for l in data_lines(os.path.join(HERE, "reviews", key + ".tsv"))}
        new = lambda n: n not in have and n.split(" // ")[0] not in have
        add = [l for l in rows if new(l.split("\t")[0]) and (not a.high_only or conf.get(l.split("\t")[0]) == "high")]
        if a.drops:
            add += ["%s\t%s\tx\tapi: doesn't do this job" % tuple(l.split("\t")[:2])
                    for l in data_lines(os.path.join(src, key + ".drop.tsv")) if new(l.split("\t")[0])]
        plan.append(("reviews/%s.tsv" % key, add, len(rows) - len(add)))
    rows = data_lines(os.path.join(src, "tags-overrides.tsv")) if a.tags else []
    have = {l.split("\t")[0] for l in data_lines(os.path.join(HERE, "reviews", "tags.tsv"))}
    add = [l for l in rows if l.split("\t")[0] not in have and l.split("\t")[0] not in gold
           and (not a.high_only or "low confidence" not in l)]
    plan.append(("reviews/tags.tsv", add, len(rows) - len(add)))
    print("From out/proposed/%s%s:" % (run, ", high confidence only" if a.high_only else ""))
    if not a.tags: print("  (existing-tag fixes not applied; add --tags after reviewing tags-overrides.tsv)")
    for fn, add, skipped in plan:
        print("  %-28s add %5d   skip %5d (already reviewed by you%s)" % (fn, len(add), skipped, ", hand-checked, or low confidence" if a.high_only else " or hand-checked"))
    if not any(add for _, add, _ in plan): return print("Nothing to add.")
    if not a.yes and input("Type yes to append these lines: ").strip().lower() != "yes": raise SystemExit("Nothing changed.")
    for fn, add, _ in plan:
        if not add: continue
        p = os.path.join(HERE, fn)
        lead = "" if not os.path.exists(p) or open(p, "rb").read()[-1:] in (b"\n", b"") else "\n"
        with open(p, "a", encoding="utf-8") as fh:
            fh.write(lead + "# grade_api %s, %s\n" % (run, time.strftime("%Y-%m-%d")) + "\n".join(add) + "\n")
    print("Done. Rebuild the site data as usual; git diff shows exactly what was added.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)
    p = sp.add_parser("prepare"); p.add_argument("res")
    p.add_argument("--model", default="claude-sonnet-5-5", choices=sorted(PRICES))
    p.add_argument("--per-request", type=int, default=10)
    p.add_argument("--part"); p.add_argument("--limit", type=int)
    p.add_argument("--calibrate", type=int, default=0); p.add_argument("--seed", type=int, default=7)
    p.add_argument("--only-roles", action="store_true"); p.add_argument("--skip-roles", action="store_true")
    p.add_argument("--include-banned", action="store_true")
    p.add_argument("--names", help="only cards named in this file (first column), e.g. a failed.tsv")
    p.add_argument("--name", help="folder name for the results (default: built from the options)")
    p.add_argument("--force", action="store_true")
    p.add_argument("--redo", action="store_true", help="also include cards that already have results")
    p.add_argument("--lean", action="store_true", help="skip the per-card analysis and working scores: ~25%% cheaper, a bit less accurate")
    p.add_argument("--grades-only", action="store_true", help="grades only, no tags (after a tagging run; pair with --only-roles)")
    p.add_argument("--no-grades", action="store_true", help="tags and downsides only (use with --skip-roles and a cheap model)")
    s = sp.add_parser("submit"); s.add_argument("--yes", action="store_true"); s.add_argument("--force", action="store_true")
    sp.add_parser("status")
    f = sp.add_parser("fetch"); f.add_argument("--from-file", help=argparse.SUPPRESS)
    c = sp.add_parser("compare"); c.add_argument("run", nargs="?", help="folder under out/proposed (default: the last prepared run)")
    ap_ = sp.add_parser("apply"); ap_.add_argument("run", nargs="?", help="folder under out/proposed (default: merged)")
    ap_.add_argument("--high-only", action="store_true", help="skip low-confidence lines")
    ap_.add_argument("--tags", action="store_true", help="also apply fixes to existing tags (the detectors are usually better; review first)")
    ap_.add_argument("--drops", action="store_true", help="also drop cards the model says don't belong in a list (score x)"); ap_.add_argument("--yes", action="store_true")
    m = sp.add_parser("merge"); m.add_argument("runs", nargs="*", help="folders under out/proposed (default: every run except calibrations)")
    a = ap.parse_args()
    {"prepare": cmd_prepare, "submit": cmd_submit, "status": cmd_status, "fetch": cmd_fetch, "compare": cmd_compare, "merge": cmd_merge, "apply": cmd_apply}[a.cmd](a)


if __name__ == "__main__":
    main()
