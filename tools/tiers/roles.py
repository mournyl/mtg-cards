"""Role detection, sub-lists, rubric scores (0-100) and one-line reasons for every tier list.

Each role function takes a pool card and returns None or a dict:
  sub    sub-list key (ranked separately on the page)
  score  0-100 on the shared rubric (efficiency, reach, speed, value, reliability)
  why    a short reason; hand reviews in reviews/<role>.tsv replace both score and reason
  face   index of the face that does the job (its cost is the one shown)
Scores here are a first pass; the build marks them Unreviewed until a person checks them.
"""
import re
from pool import strip_reminder, cost_tokens, mana_value

NUM = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
       "nine": 9, "ten": 10, "that many": 3, "x": 3}
WORD = r"(a|an|one|two|three|four|five|six|seven|eight|nine|ten|x|that many|\d+)"
TIERS = [("S", 90), ("A", 75), ("B", 60), ("C", 45), ("D", 30), ("F", 0)]


def tier_of(score):
    for t, lo in TIERS:
        if score >= lo: return t
    return "F"


def num(w):
    w = (w or "").strip().lower()
    return int(w) if w.isdigit() else NUM.get(w, 1)


def text_of(face):
    """Oracle text without reminder text, lowercased, with the card's own name replaced by '~'."""
    t = strip_reminder(face["oracle"])
    name = face["name"]
    if name:
        t = t.replace(name, "~")
        if "," in name: t = re.sub(r"\b%s\b" % re.escape(name.split(",")[0]), "~", t)
    return t.lower()


def is_type(face, *types):
    return any(re.search(r"\b%s\b" % t, face["types"]) for t in types)


def has_flash(t):
    return bool(re.search(r"(^|\n)flash(\n|$|,)", t))


def instant_speed(face, t):
    return is_type(face, "Instant") or has_flash(t)


def face_mv(face):
    return mana_value(cost_tokens(face["cost"]))


def mv_adj(mv, table):
    return table.get(mv, table.get("hi", 0) if mv > max(k for k in table if isinstance(k, int)) else 0)


def clamp(x, lo=1, hi=99):
    return max(lo, min(hi, int(round(x))))


def speed_word(face, t):
    if is_type(face, "Instant"): return "instant"
    if is_type(face, "Sorcery"): return "sorcery"
    if is_type(face, "Creature"): return "flash creature" if has_flash(t) else "creature"
    for k in ("Artifact", "Enchantment", "Planeswalker", "Battle", "Land"):
        if is_type(face, k): return k.lower()
    return "card"


def mana_str(mv, face):
    toks = cost_tokens(face["cost"])
    if is_type(face, "Land"): return "Land"
    if not toks:
        t = text_of(face)
        if re.search(r"(^|\n)suspend \d", t): return "Suspend"
        return "Free" if re.search(r"rather than pay|without paying", t) else "0-mana"
    return "%d-mana" % mv


CASTABLE_BOTH = {"Split", "Adventure", "Modal", "Omen", "Prepare"}


def spell_faces(card):
    """Faces that can do the job: castable faces only (a transformed back face is a bonus, not a spell), no land faces."""
    faces = list(enumerate(card["faces"]))
    if card.get("alt") not in CASTABLE_BOTH: faces = faces[:1]
    return [(i, f) for i, f in faces if not is_type(f, "Land")]


def nocost_penalty(face):
    """Cards with no mana cost are usually suspend cards: slow, not free."""
    if cost_tokens(face["cost"]) or is_type(face, "Land"): return 0
    t = text_of(face)
    if re.search(r"(^|\n)suspend \d", t): return -22
    return 0 if re.search(r"rather than pay|without paying", t) else -30


# ------------------------------------------------------------------ RAMP
ADD_ANY = re.compile(r"add (\{[^}]+\}(?:\{[^}]+\})*|(one|two|three|x) mana of any (one )?(color|type)|one mana of any color[^.]*|an amount of [^.]*mana|(one|two|three) mana in any combination[^.]*)")
TAP_MANA = re.compile(r"\{t\}[^.:\n]{0,60}: add ")
LAND_FETCH = re.compile(r"search your library for ([^.]*?)\b(land|plains|island|swamp|mountain|forest|basic)( cards?)?\b([^.]*)\.(\s*put [^.]*\.)?")


def _amount(add):
    a = add.group(0)
    syms = re.findall(r"\{([^}]+)\}", a)
    if syms: return len(syms)
    m = re.search(r"\b(one|two|three|x)\b mana", a)
    return num(m.group(1)) if m else 1


def ramp(card):
    if any(is_type(f, "Land") for f in card["faces"]): return None
    best = None
    for i, f in spell_faces(card):
        t = text_of(f); mv = face_mv(f); sub = None; why = None; s = 0
        add = ADD_ANY.search(t)
        perm = not is_type(f, "Instant", "Sorcery")
        grants_land = bool(re.search(r"(enchanted land|lands you control|each land|enchanted forest|enchanted plains|enchanted island|enchanted swamp|enchanted mountain|nonbasic lands|basic lands)[^.\"]{0,40}(has|have|is|are)[^.]{0,20}\"?\{t\}: add", t))
        creature_mana = bool(re.search(r"creatures you control have \"\{t\}: add", t))
        hoser = bool(re.search(r"(your opponents control|an opponent controls|lose all land types)", t)) or (is_type(f, "Aura") and re.search(r"can't attack or block|loses all abilities", t))
        aura_dork = bool(re.search(r"enchanted creature has \"\{t\}: add", t))
        if hoser and add:
            continue
        if aura_dork:
            sub = "other"; s = {1: 44, 2: 42, 3: 36}.get(mv, 30) + (4 if "draw a card" in t else 0)
            why = "%s aura that turns one of your creatures into a mana creature." % mana_str(mv, f)
        elif creature_mana:
            sub = "other"; s = {1: 60, 2: 64, 3: 58, 4: 50}.get(mv, 40)
            why = "%s %s that turns every creature you control into a mana creature." % (mana_str(mv, f), speed_word(f, t))
        elif perm and add and not grants_land and (TAP_MANA.search(t) or re.search(r"sacrifice ~: add", t)):
            amount = _amount(add)
            pre = t[max(0, add.start() - 70):add.start()]
            act = pre.split("\n")[-1]
            act_cost = sum(int(x) for x in re.findall(r"\{(\d+)\}", act.split(":")[0])) if ":" in act else 0
            amount_net = amount - act_cost
            costly = bool(re.search(r"sacrifice (a|an|another|two) |discard (a|two) |pay \d+ life|exile (a|two) ", act.split(":")[0])) if ":" in act else False
            restricted = bool(re.search(r"spend this mana only|spend that mana only", t[add.start():add.end() + 120]))
            anyc = bool(re.search(r"any (one )?color|any combination", add.group(0)))
            colors = len(set(re.findall(r"\{([wubrg])\}", add.group(0))))
            tapped = bool(re.search(r"~ enters tapped|enters the battlefield tapped", t))
            one_shot = bool(re.search(r"sacrifice ~: add|\{t\}, sacrifice ~: add", t))
            scaling = bool(re.search(r"for each|equal to", add.group(0) + t[add.end():add.end() + 40]))
            downside = bool(re.search(r"deals? \d+ damage to you|you lose \d+ life|at the beginning of your upkeep, sacrifice|doesn't untap", t))
            symbols = add.group(1) if add.group(1) and add.group(1).startswith("{") else ("one mana of any color" if anyc else "mana")
            if is_type(f, "Creature"):
                sub = "dorks"
                s = {0: 70, 1: 74, 2: 60, 3: 48, 4: 38}.get(mv, 28)
                if amount_net >= 2 or scaling: s += 12
                if anyc or colors >= 2: s += 5
                why = "%s dork that taps for %s%s." % (mana_str(mv, f), symbols, " and scales" if scaling else "")
            else:
                sub = "rocks" if is_type(f, "Artifact") else "other"
                s = {0: 78, 1: 76, 2: 68, 3: 54, 4: 40}.get(mv, 28)
                if amount_net >= 2: s += 12
                if anyc or colors >= 2: s += 4
                why = "%s %s that taps for %s" % (mana_str(mv, f), "rock" if sub == "rocks" else speed_word(f, t), symbols)
                why += "%s." % ("; enters tapped" if tapped else "")
            if tapped: s -= 8
            if one_shot: s -= 24; why = why[:-1] + "; one use only."
            if downside: s -= 8
            if costly: s -= 22; why = why[:-1] + "; costs a sacrifice, discard or life each time."
            if restricted: s -= 16; why = why[:-1] + "; the mana has spending limits."
            if "draw a card" in t: s += 3
            s += nocost_penalty(f)
        elif LAND_FETCH.search(t) and re.search(r"onto the battlefield|into your hand", t) and not re.search(r"search your library for [^.]*\b(creature|artifact|instant|sorcery|enchantment|planeswalker) card", t):
            m = LAND_FETCH.search(t)
            whole = m.group(0)
            to_bf = "onto the battlefield" in t
            two = bool(re.search(r"up to two|two basic|two land|two cards|lands? cards? and put (them|one)", whole)) or "put one onto the battlefield" in t
            untapped = to_bf and not re.search(r"onto the battlefield tapped|tapped", whole)
            nonbasic = not re.search(r"basic", whole)
            sub = "lands"
            s = {0: 70, 1: 70, 2: 68, 3: 62, 4: 50, 5: 40}.get(mv, 32)
            sac_land = bool(re.search(r"as an additional cost[^.]*sacrifice (a|an|two) (land|forest|untapped land)|sacrifice (a|an) (land|forest)[^.]*: search", t))
            if sac_land and not two: continue
            if sac_land: s -= 8
            if re.search(r"if an opponent controls more lands|if you control fewer lands|unless you control", t): s -= 10
            if not to_bf: s -= 20
            if two and to_bf: s += 7
            if untapped: s += 5
            if nonbasic and to_bf: s += 3
            if instant_speed(f, t): s += 4
            if is_type(f, "Creature"): s += 2
            what = ("two lands" if two else "a land") + (" onto the battlefield" if to_bf else " to your hand")
            why = "%s %s that puts %s%s." % (mana_str(mv, f), speed_word(f, t), what, "" if not to_bf else (" untapped" if untapped else " tapped"))
        elif re.search(r"put (a|up to (one|two)) land cards? from your hand onto the battlefield", t):
            sub = "lands"; s = {1: 60, 2: 58, 3: 54, 4: 46}.get(mv, 38)
            if re.search(r"(whenever|at the beginning|\{t\}:)", t): s += 10
            why = "%s %s that puts lands from your hand onto the battlefield." % (mana_str(mv, f), speed_word(f, t))
        elif re.search(r"play (an|two) additional lands?|play up to (one|two|three) additional lands?|play any number of lands|play an additional land", t):
            sub = "other"; s = {0: 64, 1: 66, 2: 62, 3: 60, 4: 52}.get(mv, 40)
            if re.search(r"play lands from the top of your library|you may play lands from your graveyard", t): s += 4
            why = "%s %s: extra land drops each turn." % (mana_str(mv, f), speed_word(f, t))
        elif perm and re.search(r"(spells|cards) you cast( from [a-z ]+)? cost \{(\d)\} less|spells you cast that share [^.]* cost \{\d\} less|activated abilities [^.]*cost \{\d\} less", t):
            sub = "other"; s = {1: 50, 2: 50, 3: 46, 4: 40}.get(mv, 30)
            if re.search(r"^[^.]*(creature|artifact|instant and sorcery|noncreature|[a-z]+) spells you cast cost", t): s -= 4
            why = "%s %s that makes spells cheaper." % (mana_str(mv, f), speed_word(f, t))
        elif re.search(r"(land|forest|plains|island|swamp|mountain)s? (is|are) tapped for mana, (its controller )?adds?|tapped for mana, add an additional|add an additional (one|\{)", t):
            sub = "other"; s = {1: 52, 2: 54, 3: 56, 4: 50, 5: 46}.get(mv, 40)
            if re.search(r"each player|all lands|each land", t): s -= 8
            why = "%s %s that adds extra mana when lands tap." % (mana_str(mv, f), speed_word(f, t))
        elif not perm and add:
            amount = _amount(add)
            sub = "other"; s = 26 + 6 * max(0, amount - mv) + (4 if is_type(f, "Instant") else 0)
            why = "%s ritual: one burst of mana, then it's gone." % mana_str(mv, f)
        elif re.search(r"create %s (tapped )?treasure tokens?" % WORD, t):
            n = num(re.search(r"create %s (tapped )?treasure" % WORD, t).group(1))
            repeat = bool(re.search(r"(whenever|at the beginning of)[^.]*create[^.]*treasure", t))
            sub = "other"; s = 24 + 6 * min(n, 4) + (16 if repeat else 0) - (4 if mv >= 5 else 0)
            why = "%s %s that makes %s Treasure%s." % (mana_str(mv, f), speed_word(f, t), "repeated" if repeat else str(n), "" if n == 1 and not repeat else "s")
        if sub and (best is None or s > best["score"]):
            best = dict(sub=sub, score=clamp(s), why=why, face=i)
    return best


# ------------------------------------------------------------------ CARD DRAW
DRAW = re.compile(r"(?:^|[^a-z])(you |target player |each player |that player |its controller |defending player |each opponent |target opponent |they )?(may )?draws? %s (additional )?cards?" % WORD)
IMPULSE = re.compile(r"exile the top (card|%s cards?) of your library" % WORD)


def draw(card):
    if any(is_type(f, "Land") for f in card["faces"]): return None
    best = None
    for i, f in spell_faces(card):
        t = text_of(f); mv = face_mv(f); perm = not is_type(f, "Instant", "Sorcery")
        mine = []
        for m in DRAW.finditer(t):
            who = (m.group(1) or "").strip()
            if who in ("each opponent", "target opponent", "its controller", "defending player", "that player", "they"): continue
            mine.append((m, num(m.group(3)), who))
        sub = None; s = 0; why = None
        imp = IMPULSE.search(t)
        if imp and re.search(r"you may (play|cast) (it|them|that card|those cards|cards exiled|one of)", t):
            n = 1 if imp.group(1) == "card" else num(imp.group(2))
            repeat = perm and bool(re.search(r"(whenever|at the beginning of)[^.]*exile the top", t))
            longer = "next turn" in t
            sub = "impulse"
            s = 28 + 7 * min(n, 4) + (16 if repeat else 0) + (5 if longer else 0)
            s += {0: 6, 1: 6, 2: 4, 3: 0, 4: -4, 5: -8}.get(mv, -12)
            why = "%s %s: %s%s you can play%s." % (mana_str(mv, f), speed_word(f, t), "repeated " if repeat else "",
                                                 "the top card" if n == 1 else "top %d cards" % n, " through next turn" if longer else " this turn")
        def sentence(m):
            st = max(t.rfind(".", 0, m.start()), t.rfind("\n", 0, m.start())) + 1
            en = min([x for x in (t.find(".", m.end()), t.find("\n", m.end())) if x >= 0] or [len(t)])
            return t[st:en]
        if mine:
            n = max(x[1] for x in mine)
            sym = any(x[2] == "each player" for x in mine)
            sents = [sentence(x[0]) for x in mine]
            trig = perm and any(re.search(r"(whenever|at the beginning of)", z) and not re.search(r"when ~ (enters|dies)|whenever ~ (enters|dies)", z) or re.search(r":[^:]*draw", z) for z in sents)
            rest = t
            for z in sents: rest = rest.replace(z, "")
            rest = re.sub(r"(^|\n)(flash|flying|cycling[^\n]*|scry \d|vigilance|reach|defender|haste|trample|lifelink|deathtouch|ward[^\n]*)(?=\n|$)", "", rest)
            incidental = bool(re.search(r"\b(destroy|exile|counter target|damage|return|create|gets? [+-]|gain control|search|sacrifice|tap target|untap target|fights?|prevent|gain \d+ life|counters? on|loses?|target creature|target player|each opponent|each creature|attacks?|blocks?)\b", rest))
            static_extra = bool(re.search(r"draws? an additional card", t))
            wheel = bool(re.search(r"discards? (their|his or her|your) hand,? (and |then )?(each player )?draws? seven|draws? seven cards", t))
            loot = bool(re.search(r"draw (a|one|two|three) cards?, then discard|discard (a|one) card[^.]*, then draw", t))
            if trig or static_extra:
                cand = "engine"
                cond = bool(re.search(r"whenever (a|an|another) [a-z]+ (creature )?(you control )?(enters|dies|attacks)|whenever you cast (a|an) [a-z]+ spell", t))
                paid = bool(re.search(r"\{[0-9x]\}[^:]*: draw|\{[0-9x]\}, \{t\}[^:]*: draw", t))
                cs = 56 + (8 if n >= 2 else 0) - (6 if cond else 0) - (5 if paid else 0) - (12 if sym or static_extra and "each player" in t else 0)
                cs += {0: 6, 1: 8, 2: 4, 3: 0, 4: -4, 5: -8}.get(mv, -14)
                if is_type(f, "Creature"): cs -= 3
                cwhy = "%s %s that keeps drawing%s%s." % (mana_str(mv, f), speed_word(f, t), " for every player" if sym else "", "; needs the right trigger" if cond else "")
            elif n >= 2 or wheel:
                cand = "burst"
                eff = (n / mv) if mv else 1.6
                cs = 20 + 22 * min(eff, 1.6)
                if instant_speed(f, t): cs += 8
                if "x" == (re.search(r"draws? (x) cards", t) or [None, ""])[1] if re.search(r"draws? (x) cards", t) else False: cs += 6
                if sym and not wheel: cs -= 10
                if wheel: cs += 8
                if loot: cs -= 5
                if re.search(r"you lose \d+ life|pay \d+ life", t): cs -= 1
                cwhy = "%s %s that %s." % (mana_str(mv, f), speed_word(f, t), "refills every hand" if wheel else "draws %d" % n if n < 9 else "draws a big hand")
            else:
                if incidental and not loot: continue
                cand = "cantrip"
                cs = 30 + {0: 10, 1: 8, 2: 2, 3: -4, 4: -8}.get(mv, -12)
                if instant_speed(f, t): cs += 4
                if re.search(r"scry \d|look at the top|surveil", t): cs += 4
                if loot: cs += 1
                if is_type(f, "Creature"): cs -= 2
                cwhy = "%s %s that %s." % (mana_str(mv, f), speed_word(f, t), "loots" if loot else "replaces itself")
            if sub is None or cs > s:
                sub, s, why = cand, cs, cwhy
        if sub and (best is None or s > best["score"]):
            best = dict(sub=sub, score=clamp(s), why=why, face=i)
    return best


# ------------------------------------------------------------------ TARGETED REMOVAL
PERMS = {"creature", "artifact", "enchantment", "planeswalker", "land", "battle"}


def hits_of(phrase):
    p = phrase
    if re.search(r"\bnonland permanent", p): h = PERMS - {"land"}
    elif re.search(r"noncreature, nonland permanent|nonland, noncreature permanent", p): h = {"artifact", "enchantment", "planeswalker", "battle"}
    elif re.search(r"\bnoncreature permanent", p): h = PERMS - {"creature"}
    elif re.search(r"\bpermanent\b", p) and not re.search(r"(creature|artifact|enchantment|planeswalker|land|battle) permanent", p): h = set(PERMS)
    else: h = {k for k in PERMS if re.search(r"\b%ss?\b" % k, p)}
    if re.search(r"\b(attacking|blocking|tapped) creature|creature (token|spell)", p) and not h: h = {"creature"}
    return h


def removal_sub(h):
    if not h or h == {"land"}: return None
    if "creature" in h and len(h & {"artifact", "enchantment", "planeswalker"}) >= 2: return "any"
    if "creature" in h or h == {"planeswalker"}: return "creature"
    if h & {"artifact", "enchantment"}: return "artifact-enchantment"
    if h & {"planeswalker", "battle"}: return "creature"
    return None


DESTROY = re.compile(r"(destroy|exile) (up to (one|two|three|x) )?(another )?target ([a-z ,/-]*?)(?= (an opponent controls|you don't control|with|that|and|if|unless|\.|,|;|\n)|\.|$)")
TUCK = re.compile(r"(put|shuffle|puts) (up to one )?target ([a-z ,/-]*?) (on (the )?(top|bottom) of|into) (its|their) owner'?s? library")
BOUNCE = re.compile(r"return (up to (one|two|three) )?(another )?target ([a-z ,/-]*?)( an opponent controls| you don't control| your opponents control)? to (its|their) owner'?s?'? hands?")
DAMAGE = re.compile(r"deals? (\d+|x|that much|damage equal to [^.]*?|twice x)( damage)? (damage )?to (any target|target creature( or planeswalker| or player| or battle)?|target (planeswalker|creature an opponent controls)|each of up to (one|two|three) targets|any number of targets|up to (one|two|three) targets)")
SHRINK = re.compile(r"target creature( an opponent controls| you don't control)? gets -(\d+|x)/-(\d+|x)")
EDICT = re.compile(r"(target player|target opponent|each opponent|each other player|that player) sacrifices (a|an|two|one) ([a-z ,]*?)(creature|planeswalker|nonland permanent|permanent|artifact|enchantment)")
FIGHT = re.compile(r"fights? (target|another target|up to one target)")
SOFT_AURA = re.compile(r"enchanted (creature|permanent) (can't attack or block|can't attack, block|loses all abilities|is a \d/\d|doesn't untap|has base power and toughness)|enchanted creature (can't attack, block, or crew|can't block, and its activated)")
CONDITIONS = re.compile(r"\b(nonblack|nonwhite|nonblue|nonred|nongreen|nonartifact|nonlegendary|non-[a-z]+|tapped|attacking|blocking|attacking or blocking|untapped|with (mana value|power|toughness) (\d+|x) or (less|greater)|with (mana value|power|toughness) (less|greater) than|with flying|without flying|that's (red|white|blue|black|green)|if it's (white|blue|black|red|green|multicolored|colorless|an? [a-z]+)|(white|blue|black|red|green|colorless|multicolored|monocolored) (permanent|creature|artifact|enchantment)|that (dealt|was dealt|blocked|attacked|is blocking|was blocked|has|had)|aura attached|token)\b")
ACT_COST = re.compile(r"(^|\n)([^\n:]*\{[^\n:]*):")


def removal(card):
    best = None
    for i, f in spell_faces(card):
        t = text_of(f); mv = face_mv(f)
        if re.search(r"\bcounter target\b", t) and not DESTROY.search(t): continue
        cands = []
        for m in DESTROY.finditer(t):
            phrase = m.group(5) + " " + (m.group(6) or "")
            if re.search(r"you control|you own", phrase + " " + t[m.end():m.end() + 20]) and "don't" not in phrase: continue
            if re.search(r"card|spell|graveyard|from (a|your|their) (hand|library)", phrase): continue
            if m.group(5).strip() in ("player", "opponent"): continue
            h = hits_of(m.group(5)); sub = removal_sub(h)
            if sub: cands.append(dict(kind=m.group(1), sub=sub, h=h, phrase=m.group(5).strip(), m=m))
        for m in TUCK.finditer(t):
            h = hits_of(m.group(3)); sub = removal_sub(h)
            if sub and "you control" not in m.group(0): cands.append(dict(kind="tuck", sub=sub, h=h, phrase=m.group(3).strip(), m=m))
        for m in SHRINK.finditer(t):
            n = num(m.group(3))
            if n >= 2 or m.group(3) == "x": cands.append(dict(kind="shrink", sub="creature", h={"creature"}, phrase="creature", n=n, m=m))
        for m in EDICT.finditer(t):
            h = hits_of(m.group(3) + m.group(4)); sub = removal_sub(h)
            if sub: cands.append(dict(kind="edict", sub=sub, h=h, phrase=m.group(4), each=m.group(1) in ("each opponent", "each other player"), m=m))
        for m in FIGHT.finditer(t):
            cands.append(dict(kind="fight", sub="creature", h={"creature"}, phrase="creature", m=m))
        if is_type(f, "Aura") and SOFT_AURA.search(t):
            cands.append(dict(kind="aura", sub="creature", h={"creature"}, phrase="creature", m=SOFT_AURA.search(t)))
        for m in DAMAGE.finditer(t):
            amt = m.group(1)
            n = 3 if not amt.isdigit() else int(amt)
            cands.append(dict(kind="damage", sub="damage", h={"creature"}, phrase=m.group(4), n=n, x=not amt.isdigit(), m=m))
        for m in BOUNCE.finditer(t):
            phrase = m.group(4)
            if re.search(r"card|spell|graveyard|you control", phrase) and "don't" not in (m.group(5) or ""): continue
            h = hits_of(phrase)
            if removal_sub(h): cands.append(dict(kind="bounce", sub="bounce", h=h, phrase=phrase, m=m))
        if not cands: continue
        order = {"any": 5, "creature": 4, "artifact-enchantment": 3, "damage": 2, "bounce": 1}
        kindw = {"exile": 3, "destroy": 2, "tuck": 2, "shrink": 1, "edict": 1, "aura": 0, "fight": 0, "damage": 0, "bounce": 0}
        c = max(cands, key=lambda x: (order[x["sub"]], kindw[x["kind"]]))
        sub = c["sub"]
        line_start = t.rfind("\n", 0, c["m"].start()) + 1
        act = ACT_COST.match(t[line_start:c["m"].start()] + ":") if ":" in t[line_start:c["m"].start()] else None
        if act and not is_type(f, "Instant", "Sorcery"):
            extra = sum(int(x) for x in re.findall(r"\{(\d+)\}", act.group(2))) + len(re.findall(r"\{[wubrg]\}", act.group(2)))
            mv = mv + extra
        s = {"any": 68, "creature": 60, "artifact-enchantment": 58, "damage": 46, "bounce": 46}[sub]
        s += {0: 14, 1: 12, 2: 6, 3: 0, 4: -7, 5: -13, 6: -18}.get(mv, -22)
        if not cost_tokens(f["cost"]) and not is_type(f, "Land"): s -= 10
        if re.search(r"rather than pay|without paying its mana cost|you may pay \{0\}", t): s += 10
        inst = instant_speed(f, t)
        if inst: s += 8
        if c["kind"] == "exile": s += 4
        if c["kind"] == "tuck": s += 3
        catches = []
        cond = CONDITIONS.findall(c["phrase"] + " " + t[c["m"].end():c["m"].end() + 50] if c["kind"] in ("destroy", "exile", "tuck") else c["phrase"])
        cond = [x[0] if isinstance(x, tuple) else x for x in cond]
        cond = [x for x in cond if x and x not in ("token",)]
        if cond: s -= min(16, 8 * len(set(cond))); catches.append("only " + sorted(set(cond))[0] + " targets" if not sorted(set(cond))[0].startswith("with") else "only targets " + sorted(set(cond))[0])
        if c["kind"] == "edict":
            s -= 4 if c.get("each") else 10
            catches.append("hits every opponent, but they choose" if c.get("each") else "they choose what to sacrifice")
        if c["kind"] == "fight": s -= 10; catches.append("needs a creature of yours to fight")
        if c["kind"] == "aura": s -= 10; catches.append("the creature stays on the battlefield")
        if c["kind"] == "shrink" and c.get("n", 3) < 3: s -= 6
        if c["kind"] == "damage":
            n = c.get("n", 3)
            if not c.get("x"):
                s += 0 if n >= 5 else -4 if n >= 3 else -12
            if "any target" in c["phrase"] or "player" in c["phrase"]: s += 2
            if re.search(r"divided|each of up to|any number of targets", c["phrase"]): s += 4
        if c["kind"] == "bounce" and re.search(r"nonland permanent", c["phrase"]): s += 6
        if re.search(r"as an additional cost[^.]*sacrifice", t): s -= 6; catches.append("costs you a sacrifice")
        elif re.search(r"as an additional cost[^.]*discard", t): s -= 4; catches.append("costs a discard")
        if re.search(r"its controller (creates|gains|may search|draws)|you lose|create a 3/3", t): s -= 2
        if re.search(r"draw a card|scry \d|choose one|choose two|choose one or more", t): s += 4
        perm = not is_type(f, "Instant", "Sorcery")
        if perm and re.search(r"\{t\}[^:]*:|whenever", t[:c["m"].start()] + t[c["m"].start() - 60 if c["m"].start() > 60 else 0:c["m"].start()]):
            s += 6
        verb = {"exile": "exiles", "destroy": "destroys", "tuck": "tucks", "shrink": "shrinks", "edict": "makes them sacrifice",
                "fight": "fights", "aura": "locks down", "damage": "deals damage to", "bounce": "bounces"}[c["kind"]]
        ae = sorted(c["h"] & {"artifact", "enchantment"})
        if sub == "any": target = "any nonland permanent" if "nonland" in c["phrase"] else "a permanent"
        elif sub == "creature": target = "a creature" if "creature" in c["h"] else "a planeswalker"
        elif sub == "artifact-enchantment": target = "an artifact or enchantment" if len(ae) == 2 else "an " + (ae[0] if ae else "artifact")
        elif sub == "damage": target = "a creature or player" if "any target" in c["phrase"] else "a creature"
        else: target = "a " + (c["phrase"].replace("target ", "").strip() or "permanent")
        if c["kind"] == "edict": target = "a creature" if "creature" in c["h"] else "a permanent"
        why = "%s %s that %s %s%s." % (mana_str(mv, f), speed_word(f, t), verb, target, ("; " + catches[0]) if catches else "")
        r = dict(sub=sub, score=clamp(s), why=why, face=i)
        if best is None or r["score"] > best["score"]: best = r
    return best


# ------------------------------------------------------------------ BOARD WIPES
WIPE_PATTERNS = [
    (re.compile(r"(destroy|exile) all (other )?((nonland|noncreature|nonartifact|nonenchantment|non-[a-z]+|tapped|untapped|attacking|colored|multicolored|monocolored|nontoken|token)[ ,]+)*(creatures|permanents|artifacts|enchantments|planeswalkers|artifacts and enchantments|artifacts, enchantments|creatures and planeswalkers|creatures and lands|other permanents)"), "kill"),
    (re.compile(r"(destroy|exile) each (other )?(creature|nonland permanent|artifact|enchantment|permanent|noncreature)"), "kill"),
    (re.compile(r"damage to each (other )?(creature|creature and each planeswalker|creature and planeswalker|creature and each player|creature without flying|creature with flying)"), "damage"),
    (re.compile(r"all (other )?(creatures|non-[a-z]+ creatures|creatures your opponents control) get -(\d+|x)/-(\d+|x)"), "shrink"),
    (re.compile(r"each creature (you don't control |your opponents control )?gets -(\d+|x)/-(\d+|x)"), "shrink"),
    (re.compile(r"return all (other )?(nonland permanents|creatures|artifacts|enchantments|permanents|nonland, nontoken permanents|attacking creatures|[a-z, ]*permanents)[^.]* to (their|its) owners?'?s?'? hands?"), "bounce"),
    (re.compile(r"each (player|opponent) sacrifices (all|each|[a-z]+) (creatures|nonland permanents|permanents|artifacts|enchantments)"), "edict"),
]


def wipe_flags(t):
    one_sided = bool(re.search(r"you don't control|your opponents control|opponent controls|each opponent sacrifices|creatures your opponents", t))
    return one_sided


def wipes(card):
    best = None
    for i, f in spell_faces(card):
        t = text_of(f); mv = face_mv(f)
        hit = None
        for pat, kind in WIPE_PATTERNS:
            m = pat.search(t)
            if m: hit = (m, kind); break
        overload = bool(re.search(r"(^|\n)overload \{", t))
        if not hit and overload and (BOUNCE.search(t) or DESTROY.search(t) or DAMAGE.search(t)):
            m = BOUNCE.search(t) or DESTROY.search(t) or DAMAGE.search(t)
            hit = (m, "overload")
        if not hit: continue
        m, kind = hit
        what = m.group(0)
        if re.search(r"\blands?\b", what) and not re.search(r"nonland|creatures|artifacts|enchantments|planeswalkers", what): continue
        types = set(re.findall(r"(creature|artifact|enchantment|planeswalker|permanent)", what))
        one = wipe_flags(t[max(0, m.start() - 10):m.end() + 30]) or overload
        if "permanent" in types or len(types & {"creature", "artifact", "enchantment", "planeswalker"}) >= 2:
            sub = "nonland" if "creature" in types or "permanent" in types else "artifacts-enchantments"
        elif "creature" in types: sub = "creatures"
        elif types & {"artifact", "enchantment"}: sub = "artifacts-enchantments"
        else: sub = "creatures"
        if overload:
            ot = BOUNCE.search(t) or DESTROY.search(t)
            if ot:
                h = hits_of(ot.group(4) if ot.re is BOUNCE else ot.group(5))
                sub = "nonland" if len(h & {"creature", "artifact", "enchantment"}) >= 2 else "creatures" if "creature" in h else "artifacts-enchantments"
        s = {"nonland": 68, "creatures": 64, "artifacts-enchantments": 52}[sub]
        s += {0: 14, 1: 14, 2: 12, 3: 8, 4: 0, 5: -6, 6: -10}.get(mv, -16)
        if overload:
            om = re.search(r"overload (\{[^\n]*?\})(\n|$)", t)
            omv = mana_value(cost_tokens(" ".join(re.findall(r"\{([^}]+)\}", om.group(1))))) if om else mv + 3
            s += {3: 8, 4: 0, 5: -4, 6: -8, 7: -12}.get(omv, -16) - {0: 14, 1: 14, 2: 12, 3: 8, 4: 0, 5: -6, 6: -10}.get(mv, -16)
        if one: s += 16
        if instant_speed(f, t): s += 6
        if m.group(0).startswith("exile"): s += 5
        if kind == "damage":
            dm = re.search(r"deals? (\d+|x) damage to each", t)
            n = dm.group(1) if dm else "x"
            s += 0 if n == "x" else (-2 if int(n) >= 5 else -8 if int(n) >= 3 else -16)
        if kind == "shrink":
            sm = re.search(r"get -(\d+|x)/-(\d+|x)", t)
            if sm and sm.group(2).isdigit() and int(sm.group(2)) < 3: s -= 12
        if kind == "bounce" and not one: s -= 10
        if kind == "edict": s -= 6
        if re.search(r"choose one|choose two|choose x|choose any number", t): s += 6
        if re.search(r"with (mana value|power|toughness) \d+ or (less|greater)|with flying|without flying|nonblack|nonwhite|tapped creatures|attacking creatures", what + t[m.end():m.end() + 40]): s -= 10
        if not is_type(f, "Instant", "Sorcery") and not overload: s -= 4
        label = {"nonland": "most nonland permanents", "creatures": "creatures", "artifacts-enchantments": "artifacts and enchantments"}[sub]
        verb = {"kill": "exiles" if m.group(0).startswith("exile") else "destroys", "damage": "burns", "shrink": "shrinks",
                "bounce": "bounces", "edict": "makes everyone sacrifice", "overload": "overloads to clear"}[kind]
        why = "%s %s that %s %s%s." % (mana_str(mv, f), speed_word(f, t), verb, ("your opponents' " if one else "all ") + label,
                                     "" if one else "")
        r = dict(sub=sub, score=clamp(s), why=why, face=i)
        if best is None or r["score"] > best["score"]: best = r
    return best


# ------------------------------------------------------------------ TUTORS
TUTOR = re.compile(r"search your library for (a|an|up to (one|two|three|four|five|x)|any number of|two|three|x) ([^.]*?)\b(cards?)\b([^.]*)\.")


def tutors(card):
    best = None
    for i, f in spell_faces(card):
        t = text_of(f); mv = face_mv(f)
        m = TUTOR.search(t)
        transmute = bool(re.search(r"(^|\n)transmute \{", t))
        if not m and not transmute: continue
        if m:
            desc = m.group(3)
            if re.search(r"\b(land|plains|island|swamp|mountain|forest|basic|gate|desert|locus|lair)\b", desc): continue
            if re.search(r"named|with the same name|with that name|has the same name|card named", desc + m.group(5)): continue
            if "~" in desc: continue
            if re.search(r"\bcreature\b", desc) and not re.search(r"noncreature", desc): sub = "creature"
            elif re.search(r"instant|sorcery", desc): sub = "instant-sorcery"
            elif re.search(r"artifact|enchantment|aura|equipment|vehicle", desc): sub = "artifact-enchantment"
            elif desc.strip() in ("", "a", "an") or re.search(r"^(a |an |any )?(nonland )?$|with mana value|card$|^$", desc.strip()): sub = "any"
            else: sub = "any" if not re.search(r"[a-z]{3,}", desc.strip()) else "other"
            rest = t[m.start():m.end() + 120]
        else:
            sub = "any"; desc = "same mana value"; rest = t
        dest = "hand"
        if re.search(r"onto the battlefield", rest): dest = "battlefield"
        elif re.search(r"on top of your library|put that card on top|put it on top|on top\b", rest): dest = "top"
        elif re.search(r"into your graveyard|put (it|that card|them) into your graveyard", rest): dest = "graveyard"
        s = {"any": 72, "creature": 62, "instant-sorcery": 60, "artifact-enchantment": 58, "other": 44}[sub]
        s += {0: 10, 1: 10, 2: 6, 3: 0, 4: -8, 5: -14}.get(mv, -18)
        if dest == "battlefield": s += 6
        if dest == "top": s -= 8
        if dest == "graveyard": s -= 10
        if instant_speed(f, t): s += 6
        if transmute and not m: s -= 14
        if re.search(r"with mana value (\d|x) or less|mana value equal|with mana value \d\b", desc + (m.group(5) if m else "")): s -= 6
        if re.search(r"as an additional cost[^.]*sacrifice|sacrifice (a|an|another) (creature|artifact)", t): s -= 4
        if is_type(f, "Creature") and not re.search(r"when ~ enters", t): s -= 4
        what = {"any": "any card", "creature": "a creature", "instant-sorcery": "an instant or sorcery",
                "artifact-enchantment": "an artifact or enchantment", "other": "a narrow kind of card"}[sub]
        where = {"hand": "to your hand", "battlefield": "onto the battlefield", "top": "to the top of your library", "graveyard": "into your graveyard"}[dest]
        why = "%s %s that finds %s and puts it %s." % (mana_str(mv, f), speed_word(f, t), what if not transmute or m else "a card with the same mana value", where)
        r = dict(sub=sub, score=clamp(s), why=why, face=i)
        if best is None or r["score"] > best["score"]: best = r
    return best


# ------------------------------------------------------------------ PROTECTION
KW = r"(hexproof|indestructible|shroud|protection from|ward)"


def protection(card):
    best = None
    for i, f in spell_faces(card):
        t = text_of(f); mv = face_mv(f); sub = None
        if re.search(r"(creatures|permanents|other creatures|artifacts|nonland permanents|commanders?|legendary creatures|creature tokens|other permanents) you control (gain|have|get [^.]{0,40}and (gain|have))[^.]*%s" % KW, t) or \
           re.search(r"(each|all) (creature|permanent|other permanent|nonland permanent)s? you control phases? out|permanents you control phase out|you and (each|all|other) (permanents|creatures) you control (gain|phase)|you and permanents you control", t) or \
           re.search(r"(creatures|permanents) you control can't be (the )?targets? of|spells and abilities your opponents control can't (destroy|target)|you have (hexproof|shroud)|your life total can't change", t):
            sub = "board"
        elif re.search(r"(equipped|enchanted) (creature|permanent|artifact) (has|gains|gets [^.]{0,40}and (has|gains))[^.]*%s" % KW, t) and is_type(f, "Equipment", "Aura", "Artifact", "Enchantment"):
            sub = "equipment"
        elif re.search(r"(up to one |another |up to two )?target (creature|permanent|artifact|nonland permanent|legendary creature|commander|creature or planeswalker)( you control)? (gains|gets [^.]{0,40}and (gains|has)|has|phases out|and each [^.]* gain)[^.]*(%s|phases? out)" % KW, t) or \
             re.search(r"target (creature|permanent|nonland permanent)( you control)? phases out", t):
            sub = "one"
        elif re.search(r"(spells|creature spells|noncreature spells|spells you control|commander spells)( you control)? can't be countered|your opponents can't cast spells (during your turn|this turn)|each opponent can't cast spells|spells and abilities your opponents control can't be cast|your opponents can't cast spells or activate abilities", t):
            sub = "counter"
        if not sub: continue
        s = {"board": 66, "one": 54, "equipment": 56, "counter": 52}[sub]
        s += {0: 12, 1: 8, 2: 4, 3: 0, 4: -8, 5: -12}.get(mv, -16)
        if not cost_tokens(f["cost"]) and not is_type(f, "Land"): s -= 10
        if re.search(r"rather than pay|without paying its mana cost|if you control a commander", t): s += 10
        if instant_speed(f, t): s += 6 if sub != "equipment" else 0
        if re.search(r"indestructible", t) and re.search(r"hexproof|shroud", t): s += 6
        if re.search(r"phases? out", t): s += 4
        if sub == "equipment":
            em = re.search(r"equip \{(\d)\}", t)
            s += {0: 10, 1: 6, 2: 2, 3: -2}.get(int(em.group(1)) if em else 3, -6)
        if not is_type(f, "Instant", "Sorcery") and sub in ("one", "board") and re.search(r"\{[^}]*\}[^:]*:|whenever|at the beginning", t): s += 4
        if re.search(r"until end of turn", t) and sub == "counter": s -= 2
        label = {"board": "your whole board", "one": "one creature", "equipment": "the equipped creature", "counter": "your spells"}[sub]
        how = "can't be countered" if sub == "counter" else "with " + "/".join(sorted(set(re.findall(r"hexproof|indestructible|shroud|protection|phases? out|ward", t)) or {"protection"}))
        why = "%s %s that protects %s%s." % (mana_str(mv, f), speed_word(f, t), label, "" if sub == "counter" else " (" + how.replace("with ", "") + ")")
        r = dict(sub=sub, score=clamp(s), why=why, face=i)
        if best is None or r["score"] > best["score"]: best = r
    return best


# ------------------------------------------------------------------ GRAVEYARD HATE
GY = [re.compile(p) for p in [
    r"exile (all cards from )?(target player's|each opponent's|target opponent's|each player's|all|all opponents') graveyards?",
    r"exile (all |each )?(cards?|creature cards?|instant and sorcery cards?) (from|in) (all |each |target player's |an opponent's |each opponent's |target opponent's )?graveyards?",
    r"exile (up to (one|two|three|x) )?target cards? from (a |an opponent's |any |target player's )?(single )?graveyards?",
    r"exile target (card|creature card|instant or sorcery card|artifact card)[^.]* from a graveyard",
    r"if (a|an|one or more) (card|nontoken permanent|creature|permanent)s?[^.]* would (be put into|die)[^.]*(an opponent's|a|your opponents'?) graveyards?[^.]*exile",
    r"cards in graveyards (lose all abilities|can't)|players can't cast spells from (graveyards|anywhere other than)|creature cards in graveyards can't enter|can't cast spells from graveyards",
    r"exile target player's graveyard|exile each opponent's graveyard",
]]


def gyhate(card):
    best = None
    for i, f in enumerate(card["faces"]):
        t = text_of(f); mv = face_mv(f)
        m = None
        for p in GY:
            m = p.search(t)
            if m: break
        if not m or re.search(r"exile ~ from your graveyard", m.group(0)): continue
        whole = bool(re.search(r"graveyards?\b", m.group(0)) and re.search(r"all|each|target player's|target opponent's|opponent's graveyard|would|can't|lose all", m.group(0)))
        static = bool(re.search(r"would|can't|lose all", m.group(0)))
        perm = not is_type(f, "Instant", "Sorcery")
        one_shot = not static and (not perm or bool(re.search(r"sacrifice ~|when ~ enters", t)))
        sub = "one-shot" if one_shot else "repeatable"
        s = 52 if one_shot else 60
        s += 10 if whole else -8
        s += {0: 10, 1: 8, 2: 4, 3: 0, 4: -6}.get(mv, -12)
        if is_type(f, "Land"): s += 12
        if instant_speed(f, t) or re.search(r"\{t\}, sacrifice ~: exile|sacrifice ~: exile", t): s += 6
        if re.search(r"rather than pay|exile ~ from your hand", t): s += 8
        if re.search(r"draw a card", t): s += 4
        if static and re.search(r"if a card or token would be put into a graveyard|would be put into a graveyard from anywhere", t): s -= 4
        what = "a whole graveyard" if whole and not static else "graveyards" if static else "graveyard cards"
        why = "%s %s that %s %s." % ("Land" if is_type(f, "Land") else mana_str(mv, f), speed_word(f, t), "keeps shutting off" if static else "exiles", what)
        r = dict(sub=sub, score=clamp(s), why=why, face=i)
        if best is None or r["score"] > best["score"]: best = r
    return best


# ------------------------------------------------------------------ RECURSION
REC = [
    (re.compile(r"return (up to (one|two|three|x) )?(another )?target ([a-z ,/-]*?)cards? from (your|a|an opponent's|any) graveyard to the battlefield"), "reanimate"),
    (re.compile(r"put (up to (one|two|three) )?target ([a-z ,/-]*?)cards? from (a|your|any) graveyard onto the battlefield"), "reanimate"),
    (re.compile(r"return (all|each) ([a-z ,/-]*?)cards? from (your|all|each player's|their) graveyards? to the battlefield|each player (returns|puts) [^.]*from their graveyard onto the battlefield"), "mass"),
    (re.compile(r"return (up to (one|two|three|x) )?(another )?target ([a-z ,/-]*?)cards? from your graveyard to your hand"), "to-hand"),
    (re.compile(r"return (up to (one|two|three|x) )?([a-z ,/-]*?)cards? from your graveyard to your hand"), "to-hand"),
    (re.compile(r"you may (play|cast) ([a-z ,/-]*?)(cards|spells|lands)? from your graveyard|(cast|play) [^.]*from your graveyard this turn|you may cast (instant|sorcery|creature|permanent|artifact) spells from your graveyard"), "cast"),
]


def recursion(card):
    best = None
    for i, f in spell_faces(card):
        t = text_of(f); mv = face_mv(f)
        for pat, kind in REC:
            m = pat.search(t)
            if not m: continue
            what = m.group(0)
            if "~" in what.split("graveyard")[0][-20:] or re.search(r"return ~|cast ~ from|this card from", what): continue
            sub = {"reanimate": "reanimate", "mass": "reanimate", "to-hand": "to-hand", "cast": "cast"}[kind]
            s = {"reanimate": 62, "to-hand": 52, "cast": 58}[sub]
            if kind == "mass": s += 6
            s += {0: 10, 1: 10, 2: 6, 3: 0, 4: -6, 5: -10}.get(mv, -16)
            if instant_speed(f, t): s += 6
            if re.search(r"\bcreature\b", what): pass
            elif re.search(r"\b(land)\b", what): s -= 8
            elif re.search(r"instant|sorcery|artifact|enchantment|permanent", what): s += 2
            else: s += 6
            if re.search(r"with mana value \d+ or less|mana value \d|power \d+ or less", t): s -= 6
            if not is_type(f, "Instant", "Sorcery") and re.search(r"(whenever|at the beginning|\{t\}[^:]*:)[^.]*(return|cast|play)", t): s += 6
            if re.search(r"(an opponent's|any) graveyard|from a graveyard", what): s += 2
            label = {"reanimate": "back onto the battlefield", "to-hand": "back to your hand", "cast": "playable from your graveyard"}[sub]
            target = "everything" if kind == "mass" else ("a creature" if "creature" in what else "a land" if "land" in what else "a card")
            why = "%s %s that brings %s %s." % (mana_str(mv, f), speed_word(f, t), target, label) if sub != "cast" else "%s %s that makes cards %s." % (mana_str(mv, f), speed_word(f, t), label)
            r = dict(sub=sub, score=clamp(s), why=why, face=i)
            if best is None or r["score"] > best["score"]: best = r
            break
    return best


# ------------------------------------------------------------------ LANDS
def produced(face):
    """Colors a land can produce: from Add {X} text, basic land types, or 'any color'."""
    t = text_of(face)
    if re.search(r"add (one|two|x) mana of any (one )?color|mana of any color|any color in your commander|any type|mana of the chosen color", t): return "WUBRG"
    s = set()
    for sym in re.findall(r"add ([^.]*)", t):
        s |= {c.upper() for c in re.findall(r"\{([wubrgc])\}", sym)}
    for lt, c in (("Plains", "W"), ("Island", "U"), ("Swamp", "B"), ("Mountain", "R"), ("Forest", "G")):
        if re.search(r"\b%s\b" % lt, face["types"]): s.add(c)
    return "".join(c for c in "WUBRGC" if c in s)


FETCH_TYPES = (("plains", "W"), ("island", "U"), ("swamp", "B"), ("mountain", "R"), ("forest", "G"))


def fetch_colors(face):
    """Colors a land can fetch: basic land types named in 'search your library for ...', any basic = all five."""
    out = set()
    for m in re.finditer(r"search your library for ([^.]*)", text_of(face)):
        what = m.group(1)
        if re.search(r"basic land", what): out |= set("WUBRG")
        for w, c in FETCH_TYPES:
            if re.search(r"\b%s\b" % w, what): out.add(c)
    return out


def produced_card(card):
    """Colors a land card can make or fetch, across all of its land faces (pathways, spell-lands)."""
    s = set()
    for f in card["faces"]:
        if is_type(f, "Land"): s |= set(produced(f)) | fetch_colors(f)
    return "".join(c for c in "WUBRGC" if c in s)


def lands(card):
    f0 = card["faces"][0]
    land_faces = [i for i, f in enumerate(card["faces"]) if is_type(f, "Land")]
    if not land_faces: return None
    if re.search(r"\bBasic\b", f0["types"]): return None
    if len(land_faces) == len(card["faces"]) == 2 and card.get("alt") == "Modal":
        return dict(sub="fixing", score=74, why="Pathway: pick either color as it enters, untapped.", face=0)
    if not is_type(f0, "Land"):
        i = land_faces[0]; lf = card["faces"][i]; t = text_of(lf)
        spell = card["faces"][0]; mv = face_mv(spell)
        untapped_opt = bool(re.search(r"you may pay 3 life|pay \d life\. if you don't, it enters tapped", t))
        tapped = bool(re.search(r"enters tapped", t)) and not untapped_opt
        s = 52 + (8 if untapped_opt else 0) - (6 if tapped else 0) + {1: 4, 2: 4, 3: 2, 4: 0}.get(mv, -2)
        return dict(sub="spell-lands", score=clamp(s), why="Spell or land: %s-mana %s on one side, a land%s on the other." % (mv, speed_word(spell, text_of(spell)), " that can enter untapped" if untapped_opt else " that enters tapped" if tapped else ""), face=0)
    f = f0; t = text_of(f); cols = produced(f)
    types = re.findall(r"\b(Plains|Island|Swamp|Mountain|Forest)\b", f["types"])
    nbasic = len(types)
    tapped = bool(re.search(r"(~|this land) enters tapped( with [^.]*)?\.|enters the battlefield tapped\.", t)) and not re.search(r"enters tapped unless|if you don't|you may pay", t)
    cond_untapped = bool(re.search(r"enters tapped unless|if you don't, (~|this land|it) enters tapped|you may pay 2 life\. if you don't", t))
    fetch = re.search(r"sacrifice ~: search your library for (a|an|up to two) ([^.]*?)(card|cards)", t)
    s = None; sub = "fixing"; why = None
    colored = len([c for c in cols if c in "WUBRG"])
    if fetch:
        what = fetch.group(2)
        if re.search(r"pay 1 life", t) and re.search(r"(plains|island|swamp|mountain|forest) or (an? )?(plains|island|swamp|mountain|forest)", what):
            s, why = 86, "Fetch land: grabs either basic type, shocks and duals included, untapped."
        elif re.search(r"basic land", what) and "tapped" not in t[fetch.end():fetch.end() + 60] and re.search(r"pay 1 life", t):
            s, why = 78, "Fetches any basic untapped for 1 life."
        elif re.search(r"basic land", what):
            s, why = 50, "Fetches a basic, but it enters tapped."
        else:
            s, why = 60, "Fetches a land for fixing."
        if re.search(r"up to two", fetch.group(0)): s, why = 62, "Fetches two basics tapped: slow ramp and fixing."
    elif nbasic >= 2 and not t.strip():
        s, why = 92, "Original dual: two basic types, untapped, no drawback."
    elif nbasic >= 2 and re.search(r"you may pay 2 life", t):
        s, why = 86, "Shock land: untapped for 2 life, and fetchable."
    elif nbasic >= 3:
        s, why = 72 if re.search(r"cycling", t) else 66, "Three basic types, enters tapped" + ("; cycles late." if "cycling" in t else ".")
    elif nbasic == 2 and tapped:
        s, why = 62, "Two basic types, so fetchable, but enters tapped."
    elif re.search(r"enters tapped unless you have two or more opponents", t):
        s, why = 84, "Untapped in any multiplayer game; two colors."
    elif re.search(r"enters tapped unless you control (a|an) (plains|island|swamp|mountain|forest) or (a|an) ", t):
        s, why = 74, "Check land: usually untapped once you have a basic type."
    elif re.search(r"enters tapped unless you control two or more other lands", t):
        s, why = 74, "Untapped from turn three on; two colors."
    elif re.search(r"enters tapped unless you control two or fewer other lands", t):
        s, why = 62, "Untapped early, tapped later in long games."
    elif re.search(r"you may reveal (a|an) (plains|island|swamp|mountain|forest) or", t):
        s, why = 72, "Reveal a basic type to enter untapped; two colors."
    elif re.search(r"deals 1 damage to you", t) and colored >= 2:
        s, why = 76, "Untapped two-color land; colored mana costs 1 life."
    elif re.search(r"\{t\}, pay 1 life: add", t) and colored >= 2:
        s, why = 74, "Untapped two-color land; colored mana costs 1 life."
    elif re.search(r"return a land you control to its owner's hand", t):
        s, why = 58, "Bounce land: two mana from one card, but enters tapped and returns a land."
    elif re.search(r"\{[wubrg]/[wubrg]\}, \{t\}: add", t):
        s, why = 68, "Filter land: turns one color into two."
    elif re.search(r"sacrifice it unless you return a non-lair land", t):
        s, why = 54, "Three colors untapped, but returns a land to your hand."
    elif re.search(r"depletion counter", t):
        s, why = 36, "Depletion land: two colors, but it skips untaps."
    elif re.search(r"storage counter", t):
        s, why = 34, "Storage land: slow, saves mana for a later turn."
    elif re.search(r"\{1\}, \{t\}: add \{[wubrg]\}\{[wubrg]\}", t):
        s, why = 50, "Pay {1} for two colors: fixes but never ramps."
    elif re.search(r"\{t\}: add \{[wubrg]\}\.\s*\{t\}: add \{[wubrg]\}\. activate only if you control (a|an) \w+ or (a|an) \w+", t):
        s, why = 74, "Untapped two-color land; the second color needs a basic type."
    elif re.search(r"activate only if this land entered this turn or if you[r]? control a basic land", t):
        s, why = 66, "Untapped two colors while you control a basic land."
    elif len(re.findall(r"activate only if you control (a|an) (plains|island|swamp|mountain|forest)", t)) >= 2:
        s, why = 60, "Each color needs the other's basic type; colorless otherwise."
    elif re.search(r"activate only if you control (a|an) (plains|island|swamp|mountain|forest)", t) and colored >= 2:
        s, why = 56, "Two colors only while you control the basic type; colorless otherwise."
    elif re.search(r"each opponent gains 1 life", t) and colored >= 2:
        s, why = 66, "Untapped two colors; opponents gain 1 life each tap."
    elif re.search(r"doesn't untap during your next untap step", t) and colored >= 2:
        s, why = 40, "Two colors, but it skips your next untap."
    elif re.search(r"any color in your commander's color identity", t):
        s, why = 92, "Taps for any color your commander has."
    elif colored >= 5 and tapped:
        s, why = 50, "Any color, but enters tapped."
    elif colored >= 5 and re.search(r"\{1\}, \{t\}: add one mana of any color", t):
        s, why = 40, "Any color for {1}: fixes but never ramps."
    elif colored >= 5 and re.search(r"spend this mana only to cast (a )?creature spells?( of the chosen type)?|creature spell of the chosen type", t):
        s, why = 60, "Any color, for creature spells only" + (" of the chosen type." if "chosen type" in t else ".")
    elif colored >= 5 and re.search(r"deals \d damage to you", t):
        s, why = 58, "Any color, but each colored tap hurts."
    elif colored >= 5 and re.search(r"charge counter", t):
        s, why = 50, "Any color a few times, then it runs dry."
    elif colored >= 5 and not tapped:
        s, why = 62, "Taps for any color, with a catch."
    elif colored >= 3 and tapped:
        s, why = 48, "Three colors, but enters tapped."
    elif colored >= 2 and tapped and re.search(r"you gain 1 life", t):
        s, why = 44, "Two colors, enters tapped; 1 life is little help."
    elif colored >= 2 and tapped and re.search(r"sacrifice (~|this land): draw a card", t):
        s, why = 48, "Two colors, enters tapped; cycles itself late."
    elif colored >= 2 and tapped and re.search(r"scry 1|surveil 1", t):
        s, why = 56, "Two colors, enters tapped, with a scry or surveil."
    elif colored >= 2 and tapped:
        s, why = 42, "Two colors, but enters tapped."
    elif colored >= 2 and cond_untapped:
        s, why = 70, "Two colors; usually enters untapped."
    elif colored >= 2:
        s, why = 70, "Untapped two-color land."
    if s is None:
        sub = "utility"
        abil = re.sub(r"\{t\}: add \{[wubrgc]\}\.?", "", t).strip()
        s = 38 if abil else 20
        if tapped: s -= 10
        if re.search(r"\{t\}: add \{c\}", t) and not tapped: s += 2
        if re.search(r"sacrifice ~", t): s -= 2
        if re.search(r"draw a card|create|destroy|exile|return|untap|search", abil): s += 6
        why = "Utility land%s." % (" that enters tapped" if tapped else "")
    if fetch and s >= 50: sub = "fixing"
    return dict(sub=sub, score=clamp(s), why=why, face=0)


# ------------------------------------------------------------------ BRACKET FLAGS (deck checker)
def bracket_flags(card):
    t = " ".join(text_of(f) for f in card["faces"])
    flags = set()
    if re.search(r"(destroy|exile) all (lands|permanents)|(each player|each opponent|all players) sacrifices? (all|[a-z]+) lands|return all lands|destroy all (nonbasic )?lands|lands don't untap|each player sacrifices all permanents", t):
        flags.add("mld")
    if re.search(r"take an extra turn|takes an extra turn|extra turn after this one", t):
        flags.add("extra-turn")
    return flags


ROLES = [
    ("counterspells", "Counterspells", "Stop a spell or ability on the stack.",
     {"spells": "Instants and sorceries", "creatures": "Creatures", "permanents": "Other permanents", "abilities": "Ability counters", "stack": "Bounce or steal a spell"}),
    ("ramp", "Ramp", "Get ahead on mana.",
     {"rocks": "Mana rocks", "dorks": "Mana dorks", "lands": "Land ramp", "other": "Extra lands, cost cutters, rituals"}),
    ("draw", "Card draw", "Draw, dig and keep your hand full.",
     {"burst": "Burst draw", "engine": "Draw engines", "impulse": "Impulse draw", "cantrip": "Cantrips and loots"}),
    ("removal", "Targeted removal", "Answer one threat at a time.",
     {"any": "Any permanent", "creature": "Creatures", "artifact-enchantment": "Artifacts and enchantments", "damage": "Damage", "bounce": "Bounce"}),
    ("wipes", "Board wipes", "Reset the board.",
     {"creatures": "Creatures", "nonland": "Nonland permanents", "artifacts-enchantments": "Artifacts and enchantments"}),
    ("tutors", "Tutors", "Find the card you need.",
     {"any": "Any card", "creature": "Creatures", "instant-sorcery": "Instants and sorceries", "artifact-enchantment": "Artifacts and enchantments", "other": "Narrow tutors"}),
    ("protection", "Protection", "Keep your key pieces alive.",
     {"board": "Whole board", "one": "One creature", "equipment": "Equipment and auras", "counter": "Can't be countered"}),
    ("gyhate", "Graveyard hate", "Shut off graveyard decks.",
     {"one-shot": "One-shot", "repeatable": "Repeatable or static"}),
    ("recursion", "Recursion", "Get cards back from the graveyard.",
     {"reanimate": "Reanimation", "to-hand": "Return to hand", "cast": "Cast from graveyard"}),
    ("lands", "Lands", "Fixing, utility lands and spell-lands.",
     {"fixing": "Fixing", "utility": "Utility lands", "spell-lands": "Spell-lands (MDFCs)"}),
]
DETECT = {"ramp": ramp, "draw": draw, "removal": removal, "wipes": wipes, "tutors": tutors,
          "protection": protection, "gyhate": gyhate, "recursion": recursion, "lands": lands}


# ------------------------------------------------------------------ COUNTERSPELLS (detected from Forge's card scripts)
CNT = re.compile(r"\b(?:SP|DB|AB)\$\s*Counter\b")
STK = re.compile(r"\b(?:SP|DB|AB)\$\s*ChangeZone\b.*TgtZone\$\s*[^|]*Stack")
STK2 = re.compile(r"\b(?:SP|DB|AB)\$\s*ChangeZone\b(?=.*Origin\$\s*Stack)(?=.*Defined\$\s*(?:Targeted|ParentTarget))")
CTL = re.compile(r"\b(?:SP|DB|AB)\$\s*ControlSpell\b")


def counterspells(card):
    kinds, face = set(), None
    for i, f in enumerate(card["faces"]):
        for l in f["lines"]:
            k = None
            if CNT.search(l):
                if re.search(r"Defined\$\s*Self\b", l) and "ValidTgts" not in l: continue
                m = re.search(r"TargetType\$\s*([^|]+)", l)
                tt = [x.strip() for x in m.group(1).split(",")] if m else ["Spell"]
                if any(x in ("Activated", "Triggered") for x in tt): kinds.add("ability")
                if any(x not in ("Activated", "Triggered") for x in tt): kinds.add("spell")
                k = 1
            if STK.search(l) or STK2.search(l): kinds.add("stack"); k = 1
            if CTL.search(l): kinds.add("steal"); k = 1
            if k and face is None: face = i
    if not kinds: return None
    f = card["faces"][face or 0]; t = text_of(f); mv = face_mv(f)
    if "spell" in kinds:
        sub = "creatures" if is_type(f, "Creature") else "spells" if is_type(f, "Instant", "Sorcery") else "permanents"
    elif "ability" in kinds: sub = "abilities"
    else: sub = "stack"
    soft = bool(re.search(r"unless (its|that|the spell's) (controller|player)|unless they pay|unless that player", t))
    s = {0: 58, 1: 56, 2: 54, 3: 48, 4: 40, 5: 34}.get(mv, 28)
    if soft: s -= 10
    if re.search(r"noncreature|creature spell|instant or sorcery|artifact|enchantment|with mana value", t): s -= 4
    if re.search(r"rather than pay|without paying|you may pay \{0\}", t): s += 8
    if is_type(f, "Creature") and not has_flash(t): s -= 6
    why = "%s %s that %s." % (mana_str(mv, f), speed_word(f, t), "counters a spell unless they pay" if soft else "counters a spell" if sub != "abilities" else "counters an ability" if sub == "abilities" else "removes a spell from the stack")
    return dict(sub=sub, score=clamp(s), why=why, face=face or 0, soft=soft)


DETECT = {"counterspells": counterspells, **DETECT}
