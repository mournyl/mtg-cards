"""What each card does: function tags for every card in the pool.

Three signals, strongest first:
  1. Forge's card scripts. Every ability, trigger, static and replacement effect is followed through its
     sub-abilities (SubAbility$, Execute$, Choices$ ...) and each effect is mapped to tags from its type,
     targets, cost and zones. "Defined$ Self" effects never give team tags (a self-pump is a mana sink, not Pump).
  2. Keywords (K: lines): Flying, Flash, Flashback, Cycling, Afterlife ...
  3. Rules text, for wording the scripts don't make easy (kindred, "double strike", odd old cards).
Hand fixes live in reviews/tags.tsv: name<TAB>+tag -tag ...<TAB>note.
The new tags and downsides (AI_ONLY) come from reviews/tags-ai.tsv, written from the Claude tagging run.

Coverage = cards with at least one job tag (card-type tags like Aura or Equipment alone don't count).
score() checks the tags against tests/tags-gold.tsv (500 hand-checked cards) and tests/tags-holdout.tsv (200 more that
were never used to tune the rules); build.py stops if coverage drops under 96.5% or precision under 95%.
"""
import os
import re
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))

# key, label, group. Order = display priority (more specific first); generic tags sit at the end.
TAGS = [
    # interaction
    ("removal", "Removal", "Interaction"), ("edict", "Edict", "Interaction"), ("wipe", "Board wipe", "Interaction"),
    ("counter", "Counterspell", "Interaction"), ("bounce", "Bounce", "Interaction"), ("pinger", "Pinger", "Interaction"),
    ("burn", "Burn", "Interaction"), ("steal", "Steal", "Interaction"), ("gyhate", "Graveyard hate", "Interaction"),
    ("tapper", "Tapper", "Interaction"), ("stax", "Stax / tax", "Interaction"), ("fog", "Fog", "Interaction"),
    ("abilityremove", "Ability removal", "Interaction"), ("landdestroy", "Land destruction", "Interaction"),
    # resources
    ("ramp", "Mana generation", "Resources"), ("landramp", "Extra lands", "Resources"), ("treasure", "Treasure tokens", "Resources"),
    ("costreduce", "Cost reducer", "Resources"),
    ("draw", "Card draw", "Resources"), ("select", "Card selection", "Resources"), ("tutor", "Tutor", "Resources"),
    ("wheel", "Wheel", "Resources"), ("freecast", "Free to cast", "Resources"),
    # defense
    ("protect", "Protection", "Defense"), ("phasing", "Phasing", "Defense"), ("blink", "Blink", "Defense"),
    ("regen", "Regenerate", "Defense"), ("resilient", "Hard to kill", "Defense"), ("pillowfort", "Pillow fort", "Defense"),
    # engines
    ("reanimate", "Reanimation", "Engines"), ("recursion", "Recursion", "Engines"), ("cheat", "Cheat into play", "Engines"),
    ("tokens", "Tokens", "Engines"), ("counters", "+1/+1 counters", "Engines"), ("proliferate", "Proliferate", "Engines"),
    ("sacoutlet", "Sac outlet", "Engines"), ("death", "Death trigger", "Engines"), ("lifegain", "Lifegain", "Engines"),
    ("drain", "Life drain", "Engines"), ("mill", "Mill", "Engines"), ("discard", "Discard", "Engines"),
    ("copy", "Copy spells", "Engines"), ("clone", "Clone", "Engines"), ("landfall", "Landfall", "Engines"),
    ("spellpayoff", "Spell payoff", "Engines"), ("gycast", "Graveyard cast", "Engines"),
    ("selfmill", "Self-mill", "Engines"), ("triggerdouble", "Trigger doubler", "Engines"), ("doubler", "Doubler", "Engines"),
    ("damageamp", "Damage amplifier", "Engines"), ("artifactpay", "Artifact payoff", "Engines"),
    ("enchantpay", "Enchantment payoff", "Engines"), ("poison", "Poison / infect", "Engines"), ("cmdrpay", "Commander payoff", "Engines"),
    # creatures and combat
    ("double", "Double power", "Combat"), ("swap", "Switch P/T", "Combat"), ("anthem", "Anthem", "Combat"),
    ("pump", "Pump", "Combat"), ("buff", "Stat boost", "Combat"), ("scaling", "Scaling body", "Combat"), ("extracombat", "Extra combat", "Combat"),
    ("untap", "Untap", "Combat"), ("lure", "Lure", "Combat"), ("animate", "Animate", "Combat"), ("manasink", "Mana sink", "Combat"),
    ("evasion", "Evasion", "Combat"), ("deathtouch", "Deathtouch", "Combat"), ("firststrike", "First strike", "Combat"),
    ("haste", "Haste", "Combat"), ("flash", "Flash", "Combat"), ("defender", "Defender", "Combat"),
    ("keyword", "Combat keyword", "Combat"), ("vanilla", "Vanilla", "Combat"),
    # politics and turns
    ("extraturn", "Extra turn", "Politics"), ("goad", "Goad", "Politics"), ("monarch", "Monarch", "Politics"),
    ("vote", "Vote", "Politics"), ("grouphug", "Group hug", "Politics"),
    # kindred
    ("kindred", "Kindred", "Kindred"),
    # lands and permanents
    ("fixing", "Fixing land", "Lands"), ("utilityland", "Utility land", "Lands"), ("basic", "Basic land", "Lands"), ("monoland", "Mana land", "Lands"),
    ("etb", "Enters trigger", "Triggers"), ("attack", "Attack trigger", "Triggers"),
    ("aura", "Aura", "Permanents"), ("equipment", "Equipment", "Permanents"), ("vehicle", "Vehicle", "Permanents"),
    ("saga", "Saga / class", "Permanents"), ("planeswalker", "Planeswalker", "Permanents"),
    # downsides: what the card costs you (from the AI tagging run, reviews/tags-ai.tsv)
    ("lifecost", "Costs life", "Downsides"), ("selfdiscard", "You discard", "Downsides"), ("sacrifice", "Sacrifice cost", "Downsides"),
    ("exilecost", "Exiles your cards", "Downsides"), ("helpsopp", "Helps an opponent", "Downsides"), ("upkeep", "Upkeep cost", "Downsides"),
    ("tapped", "Enters tapped", "Downsides"), ("symmetric", "Affects you too", "Downsides"), ("restricted", "Combat drawback", "Downsides"),
]
KEYS = [t[0] for t in TAGS]
LABEL = {t[0]: t[1] for t in TAGS}
ORDER = {k: i for i, k in enumerate(KEYS)}
TYPE_ONLY = {"aura", "equipment", "vehicle", "saga", "planeswalker"}
DOWNSIDES = {t[0] for t in TAGS if t[2] == "Downsides"}
# tags that only come from reviews/tags-ai.tsv (the Claude tagging run; tools/tiers/grade_api.py). No detector rule
# finds them and tests/tags-gold.tsv doesn't label them, so the gold-set score leaves them out.
AI_ONLY = DOWNSIDES | {"abilityremove", "landdestroy", "wheel", "freecast", "pillowfort", "selfmill", "triggerdouble", "doubler",
                       "damageamp", "artifactpay", "enchantpay", "poison", "cmdrpay", "grouphug"}

# ---------- Forge scripts ----------
ROOT_RE = re.compile(r"^(A|T|S|R):(.*)$")


def _params(body):
    out = {}
    for part in body.split("|"):
        if "$" in part:
            k, v = part.split("$", 1); out[k.strip()] = v.strip()
        elif part.strip():
            out[part.strip()] = ""
    return out


def _api(p):
    for k in ("SP", "AB", "DB"):
        if k in p: return p[k]
    return None


def effects(face):
    """Every effect a face can produce: (root kind, root params, params). Follows sub-abilities through SVars."""
    sv, roots = {}, []
    for line in face.get("lines", []):
        if line.startswith("SVar:"):
            k, _, v = line[5:].partition(":"); sv[k.strip()] = v
        else:
            m = ROOT_RE.match(line)
            if m: roots.append((m.group(1), m.group(2)))
    out = []
    for line in face.get("lines", []):
        if line.startswith("K:"):
            for part in re.split(r"[:,]", line[2:]):
                part = part.strip()
                if part in sv and re.match(r"\s*(DB|AB|SP)\$", sv[part]): roots.append(("K", sv[part]))
    for kind, body in roots:
        rootp = _params(body)
        seen = set()
        stack = [(body, None)]
        while stack:
            b, players = stack.pop()
            p = _params(b)
            if players and p.get("Defined") == "Remembered": p["Defined"] = players
            out.append((kind, rootp, p))
            sub_players = p.get("RepeatPlayers") or players
            for v in p.values():
                for name in v.split(","):
                    name = name.strip()
                    if name in sv and name not in seen and re.match(r"\s*(DB|AB|SP)\$|\s*Mode\$|\s*Event\$", sv[name]):
                        seen.add(name); stack.append((sv[name], sub_players))
    return out


def keywords(face):
    return [line[2:] for line in face.get("lines", []) if line.startswith("K:")]


# ---------- helpers ----------
def _has(s, *words):
    return any(w in (s or "") for w in words)


SELF = ("Self", "Card.Self", "Creature.Self", "Enchanted", "Equipped")


def _is_self(p):
    d = p.get("Defined", "")
    return (d in ("Self", "Card.Self") or d.startswith("Self")) and "ValidTgts" not in p


def _targets_opp(p):
    s = p.get("ValidTgts", "") + "|" + p.get("Defined", "") + "|" + p.get("ValidCards", "") + "|" + p.get("ValidPlayers", "")
    return _has(s, "Opponent", "OppCtrl", "Player", "Any") and not _has(p.get("Defined", ""), "You", "Self")


def _num(v):
    m = re.match(r"^[+]?(-?\d+)$", (v or "").strip())
    return int(m.group(1)) if m else None


def kind_root_tgt(rootp):
    return bool(rootp.get("ValidTgts")) or rootp.get("SP") == "ChooseSource" or rootp.get("AB") == "ChooseSource"


def _mana_cost(cost):
    return any(re.fullmatch(r"\d+|X|[WUBRGCS]{1,2}|[WUBRG2]/[WUBRGP]", tok) for tok in (cost or "").split())


def _repeatable(kind, rootp):
    """An activated ability or a recurring trigger (not a one-time enters/dies/cast trigger of the card itself)."""
    if kind == "A":
        return "AB" in rootp and not re.search(r"(Sac|Exile)<1/CARDNAME>", rootp.get("Cost", ""))
    if kind == "T":
        mode, vc = rootp.get("Mode", ""), rootp.get("ValidCard", "")
        if mode in ("ChangesZone", "ChangesZoneAll") and _has(vc, "Card.Self", "Creature.Self") and rootp.get("Destination") in ("Battlefield", "Graveyard"):
            return False
        if mode == "SpellCast" and _has(vc, "Card.Self"): return False
        if mode == "TurnFaceUp": return False
        return True
    return False


def _kw_tags(k, out):
    base = k.split(":")[0].strip()
    low = base.lower()
    if low in ("flying", "menace", "trample", "shadow", "horsemanship", "fear", "intimidate", "skulk", "landwalk") or low.endswith("walk"):
        out.add("evasion")
    elif low in ("first strike", "double strike"): out.add("firststrike")
    elif low == "deathtouch": out.add("deathtouch")
    elif low == "lifelink": out.add("lifegain")
    elif low == "haste": out.add("haste")
    elif low == "flash": out.add("flash")
    elif low == "defender": out.add("defender")
    elif low in ("vigilance", "reach", "banding", "bushido", "flanking", "rampage", "exalted", "battle cry", "melee", "dethrone",
                 "infect", "toxic", "wither", "annihilator", "afflict", "mentor", "training", "provoke", "ninjutsu", "myriad",
                 "frenzy", "skulk", "blitz", "dash", "enlist", "ravenous", "bloodthirst", "poisonous", "fuse"):
        out.add("keyword")
        if low in ("afflict",): out.add("drain")
        if low in ("myriad",): out.add("tokens")
        if low == "mentor" or low == "training": out.add("counters")
        if low == "provoke": out.add("lure")
    elif low in ("hexproof", "shroud", "indestructible", "ward", "persist", "undying", "totem armor", "umbra armor") or low.startswith("protection"):
        out.add("resilient")
    elif low == "soulshift": out.add("recursion")
    elif low in ("flashback", "escape", "unearth", "embalm", "eternalize", "disturb", "retrace", "jump-start", "aftermath", "encore",
                 "scavenge", "harmonize", "mayhem"):
        out.add("gycast")
        if low in ("embalm", "eternalize", "encore"): out.add("tokens")
        if low == "scavenge": out.add("counters")
    elif low in ("cycling", "typecycling", "landcycling", "basic landcycling"):
        out.add("select")
    elif low in ("afterlife", "fabricate", "mobilize", "squad", "offspring", "living weapon", "for mirrodin", "incubate"):
        out.add("tokens")
        if low == "fabricate": out.add("counters")
    elif low == "etbcounter":
        if "P1P1" in k: out.add("counters")
    elif low in ("modular", "graft", "evolve", "outlast", "riot", "backup", "renown", "adapt", "bolster", "sunburst", "reinforce", "tribute", "unleash"):
        out.add("counters")
    elif low == "exploit": out.add("sacoutlet")
    elif low == "prowess": out.add("spellpayoff")
    elif low == "storm": out.add("copy")
    elif low in ("cascade", "discover"): out.add("cheat")
    elif low == "changeling": out.add("kindred")
    elif low == "extort": out.update(("drain", "lifegain"))
    elif low in ("equip", "reconfigure"): out.add("equipment")
    elif low == "bestow": out.add("aura")
    elif low == "crew": out.add("vehicle")
    elif low == "cumulative upkeep" and "AddMana" in k: out.add("ramp")


def _kwlist_tags(kws, out):
    """Keywords granted by a pump or a static ('Flying & First Strike', 'Haste')."""
    for k in re.split(r"\s*&\s*|,\s*", kws or ""):
        k = k.replace("HIDDEN ", "").strip()
        if not k: continue
        if re.search(r"can't be blocked|Unblockable", k, re.I): out.add("evasion"); continue
        if re.search(r"can block any number|can block an additional", k, re.I): out.add("keyword"); continue
        if re.search(r"can't block", k, re.I): continue
        _kw_tags(k, out)


def _pos(v):
    v = (v or "").strip()
    return bool(v) and not v.startswith("-") and v not in ("0", "+0")


TOKEN_KIND = [("treasure", ("treasure",)), ("ramp", ("powerstone", "gold", "eldrazi_spawn", "eldrazi_scion")), ("draw", ("clue",)),
              ("lifegain", ("food",)), ("select", ("blood", "c_a_map")), ]


def _effect_tags(card, face, kind, rootp, p, out, why):
    api = _api(p)
    is_land = bool(re.search(r"\bLand\b", face["types"]))
    if api is None and p is not rootp:
        # a static, replacement or trigger made by an Effect$ or granted to something (StaticAbilities$, AddTrigger$ ...)
        kind = "R" if "Event" in p else ("T" if "Execute" in p else ("S" if "Mode" in p else kind))
    if kind == "T" and api is None:
        mode, vc = p.get("Mode", ""), p.get("ValidCard", "")
        if mode in ("ChangesZone", "ChangesZoneAll") and p.get("Destination") == "Battlefield":
            if _has(vc, "Land") and not _has(vc, "Self", "nonLand"): out.add("landfall")
            else: out.add("etb")
        elif mode in ("ChangesZone", "ChangesZoneAll") and p.get("Origin") == "Battlefield" and p.get("Destination") == "Graveyard":
            out.add("death")
        elif mode in ("SpellCast", "SpellCastOrCopy", "SpellCopy") and (_has(vc, "Card.Self", "IsCommander", "IsRemembered") or _has(p.get("ValidActivatingPlayer", ""), "Opponent")):
            pass   # its own cast, a commander, a remembered card or an opponent's spell
        elif mode in ("SpellCastOrCopy", "SpellCopy"):
            out.add("spellpayoff")
        elif mode == "SpellCast" and _has(p.get("ValidActivatingPlayer", "") + p.get("ValidCard", ""), "You", "Card", "Instant", "Sorcery", "Spell"):
            out.add("spellpayoff")
        elif mode in ("Attacks", "AttackersDeclared", "AttackerBlocked", "AttackerUnblocked") or (mode in ("DamageDone", "DamageDoneOnce") and p.get("CombatDamage") == "True"):
            out.add("attack")
        elif mode == "LifeGained": out.add("lifegain")
        elif mode in ("Sacrificed",): out.add("death")
        return
    if kind == "S" and api is None:
        mode = p.get("Mode", "")
        aff = p.get("Affected", "") + "|" + p.get("ValidCard", "") + "|" + p.get("AffectedDefined", "")
        if mode == "Continuous":
            ap, ad = _num(p.get("AddPower")), _num(p.get("AddToughness"))
            if ap is None and _pos(p.get("AddPower")): ap = 1
            if ad is None and _pos(p.get("AddToughness")): ad = 1
            kws = p.get("AddKeyword", "") + " & " + p.get("AddHiddenKeyword", "")
            if "AdjustLandPlays" in p and not _has(aff, "Opponent"): out.add("landramp")
            if _has(kws, "doesn't untap") and not _has(aff, "Self", "YouCtrl", "Enchanted", "Equipped"): out.add("stax")
            if not _has(aff, "OppCtrl"):
                got = set(); _kwlist_tags(p.get("AddKeyword", ""), got)
                if "resilient" in got and not (_has(aff, "Self") or p.get("AffectedDefined") == "Self"):
                    got.discard("resilient"); got.add("protect")   # hexproof/indestructible handed to other things protects them
                out |= got
            if _has(aff, "Card.Self", "Creature.Self") or p.get("Affected", "") in ("Card.Self", "Creature.Self") or p.get("AffectedDefined") == "Self":
                if (ap or 0) > 0 or (ad or 0) > 0: out.add("buff")
            if p.get("GainControl") == "You": out.add("steal")
            if p.get("Affected") == "You" and re.search(r"Hexproof|Shroud|Protection", kws): out.add("protect")
            if "MayPlayWithoutManaCost" in p and not _has(aff, "Self"): out.add("cheat")
            free_only = "MayPlayDontGrantZonePermissions" in p
            if p.get("CanBlockAny") or p.get("CanBlockAmount"): out.add("keyword")
            if "MayPlay" in p and _has(p.get("AffectedZone", ""), "Exile") and _has(aff, "IsRemembered", "Remembered"):
                out.add("steal" if _has(rootp.get("ValidTgts", ""), "Opponent") else "draw")
            if _has(aff, "EnchantedBy", "EquippedBy", "AttachedBy", "Creature.Enchanted", "Creature.Equipped", "Card.EnchantedBy", "Card.EquippedBy") or p.get("AffectedDefined") in ("Enchanted", "Equipped", "Attached"):
                if re.search(r"Haste", kws): out.add("haste")
                if (ap or 0) > 0 or (ad or 0) > 0 or (_num(p.get("SetPower")) or 0) >= 4: out.add("buff")
                if re.search(r"Hexproof|Indestructible|Shroud|Protection", kws): out.add("protect")
                if re.search(r"Flying|Trample|Menace|Unblockable|Shadow", kws): out.add("evasion")
                if ((ap or 0) < 0 and (ad or 0) < 0) or (ap or 0) <= -3 or _has(kws, "can't attack or block", "CARDNAME can't attack or block") or \
                        ("RemoveAllAbilities" in p and p.get("IsCurse") != "False") or (_num(p.get("SetPower")) is not None and _num(p.get("SetPower")) <= 1 and "RemoveAllAbilities" in p) or \
                        (_num(p.get("SetPower")) == 0): out.add("removal")
            elif _has(aff, "YouCtrl") and not _has(aff, "Self"):
                if (ap or 0) > 0 or (ad or 0) > 0 or p.get("AddPower", "").startswith("+") and not p.get("AddPower", "").startswith("+0"): out.add("anthem")
                if re.search(r"Hexproof|Indestructible|Shroud|Protection", kws): out.add("protect")
                if re.search(r"Flying|Trample|Menace|Shadow", kws): out.add("evasion")
                if re.search(r"Haste", kws): out.add("haste")
                if "MayPlay" in p and _has(p.get("Affected", ""), "Graveyard", "InZoneGraveyard"): out.add("recursion")
            elif (aff.startswith("Creature") or aff.startswith("Card.token") or aff.startswith("Permanent")) and not _has(aff, "OppCtrl", "nonYouCtrl", "Self") and ((ap or 0) > 0 or (ad or 0) > 0) and (ad or 0) >= 0:
                out.add("anthem")
            elif _has(aff, "OppCtrl", "Creature.nonYouCtrl") or (aff.startswith("Creature") and not _has(aff, "YouCtrl", "Self", "Other")):
                if (ad or 0) < 0: out.add("wipe")
                if _has(kws, "can't attack", "can't block", "doesn't untap", "CARDNAME can't attack"): out.add("stax")
            elif _has(aff, "Enchanted") and _has(kws, "doesn't untap"):
                out.add("removal")
            if "MayPlay" in p and _has(p.get("AffectedZone", "") + aff, "Graveyard") and not free_only: out.add("recursion")
            if "MayPlay" in p and _has(p.get("AffectedZone", ""), "Library") and not free_only: out.add("draw")
            if _has(p.get("CharacteristicDefining", ""), "True") or (("SetPower" in p or "SetToughness" in p) and _has(aff, "Self") and not _num(p.get("SetPower"))):
                out.add("scaling")
        elif mode == "ReduceCost" and not _has(aff, "Card.Self", "Creature.Self") and not p.get("ValidCard", "").startswith("Card.Self"):
            out.add("costreduce")
            if p.get("Type", "Spell") not in ("Ability", "Equip", "Activated") and not p.get("ValidSpell", "").startswith("Activated"): pass   # cheaper spells: Cost reducer only
        elif mode == "CantTarget":
            vt = p.get("ValidTarget", "") + p.get("ValidCard", "") + p.get("ValidPlayer", "")
            if _has(vt, "YouCtrl", "You"): out.add("protect")
            elif _has(vt, "Self"): out.add("resilient")
        elif mode.startswith("Cant") and _has(aff, "EnchantedBy", "Enchanted") and _has(mode, "CantAttack", "CantBlock", "CantBeActivated") and not re.search(r"Enchanted(By)?\+", aff):
            out.add("removal")
        elif mode == "RaiseCost" or (mode.startswith("Cant") and mode not in ("CantBlockBy",) and not _has(aff, "Self")):
            if mode == "CantBeCast" and (_has(p.get("Caster", ""), "You") and not _has(p.get("Caster", ""), "Opponent") or "ValidCard" in p and "Caster" not in p and _has(p.get("Description", ""), "You can't")):
                pass   # a restriction on yourself
            elif mode in ("CantBeCast", "CantAttack", "CantAttackUnless", "CantGainLife", "CantDraw", "CantSearchLibrary", "CantPlayLand", "CantBeActivated",
                        "RaiseCost", "CantTarget", "CantUntap", "CantBlock", "CantCrew", "CantPutCounter") or mode == "CantSacrifice" and not _has(aff, "YouCtrl"):
                out.add("stax")
        elif mode == "CantBlockBy" and _has(p.get("ValidAttacker", ""), "Self"):
            out.add("evasion")
        elif mode in ("MustBeBlockedByAll", "MustBeBlockedBy"):
            out.add("lure")
        elif mode == "MustAttack" and not _has(aff + p.get("ValidCreature", ""), "Self") and not _has(aff, "YouCtrl"):
            out.add("goad")
        elif mode == "Panharmonicon": out.add("etb")
        return
    if kind == "R" and api is None:
        ev = p.get("Event", "")
        if ev == "DamageDone" and "PreventionEffect" in p and "Prevent" not in p: p = dict(p, Prevent="True")
        if ev == "DamageDone" and "Prevent" in p and _has(p.get("ValidTarget", ""), "IsRemembered", "Targeted") and kind_root_tgt(rootp):
            out.add("protect"); return
        if ev == "DamageDone" and "Prevent" not in p and "DamageTarget" not in p and \
                (_has(p.get("ValidSource", ""), "YouCtrl") or re.search(r"\b(double that damage|plus \d|plus X)\b", p.get("Description", ""))):
            out.add("burn")   # damage amplifiers
        elif ev == "DamageDone" and "Prevent" in p and _has(p.get("ValidTarget", ""), "Enchanted", "Equipped") and not _has(p.get("ValidSource", ""), "Enchanted", "Equipped"):
            out.add("protect")
        elif ev == "DamageDone" and "Prevent" in p and _has(p.get("ValidSource", ""), "Enchanted", "Equipped") and not _has(p.get("ValidSource", ""), "YouCtrl"):
            out.add("removal")   # "prevent all damage enchanted creature would deal"
        elif ev == "DamageDone" and "Prevent" in p and _has(p.get("ValidTarget", ""), "Self", "EffectSource") and not _has(p.get("ValidTarget", ""), "YouCtrl"):
            out.add("resilient")
        elif ev == "DamageDone" and "Prevent" in p:
            vt = p.get("ValidTarget", "")
            if _has(vt + p.get("ValidSource", ""), "YouCtrl", "You") or p.get("IsCombat") == "True" or not vt or vt in ("Player", "Player.You", "You", "Creature", "Permanent"):
                out.add("fog" if p.get("IsCombat") == "True" or not _has(vt, "Self") else "resilient")
        elif ev == "DamageDone" and "DamageTarget" in p and p.get("DamageTarget") not in ("You",):
            out.add("protect")
        elif ev == "Counter" and _has(p.get("ValidSA", ""), "YouCtrl", "Spell.You"):
            out.add("protect")
        elif ev == "CreateToken": out.add("tokens")
        elif ev == "Moved" and p.get("Destination") == "Battlefield" and _has(p.get("ReplaceWith", "") + p.get("Description", ""), "Tapped", "tapped") and \
                not _has(p.get("ValidCard", ""), "Self", "YouCtrl") and not re.search(r"\bLand\b", face["types"]):
            out.add("stax")   # "permanents your opponents control enter tapped"
        elif ev == "Untap" and p.get("ValidCard") and not _has(p.get("ValidCard", ""), "Self", "YouCtrl", "Enchanted", "Equipped", "Remembered", "EffectSource") \
                and not re.search(r"\bLand\b", face["types"]) and p.get("ActiveZones", "Battlefield") != "Command":
            out.add("stax")
        elif ev == "AddCounter" and _has(p.get("ValidCard", "") + p.get("ValidCounterType", "") + p.get("CounterType", ""), "P1P1", "YouCtrl"): out.add("counters")
        elif ev == "Moved" and _has(p.get("ValidCard", ""), "OppOwn", "OppCtrl") and p.get("Destination") == "Graveyard": out.add("gyhate")
        elif ev == "Moved" and p.get("Destination") == "Graveyard" and _has(p.get("ValidCard", ""), "Card.nonToken", "Card.Other") and p.get("ActiveZones") == "Battlefield": out.add("gyhate")
        elif ev == "GainLife" or ev == "LifeGained": out.add("lifegain")
        elif ev == "Draw" and _has(p.get("ValidPlayer", ""), "Opponent"): out.add("stax")
        elif ev == "Draw": out.add("draw")
        return
    if not api: return
    a = api
    tgt, dfn = p.get("ValidTgts", ""), p.get("Defined", "")
    selfish = _is_self(p) or (a in ("Pump", "Animate", "PutCounter", "Regenerate", "Protection") and not tgt and not dfn)
    rep = _repeatable(kind, rootp)
    if a == "Draw":
        if _has(dfn, "TargetedController", "TargetedOwner", "ParentTargeted", "TriggeredCardController", "TriggeredActivator") and not tgt: pass
        elif not _has(dfn, "Opponent") or _has(dfn, "Player"): out.add("draw")
    elif a in ("Dig", "DigUntil", "PeekAndReveal", "Scry", "Surveil", "RearrangeTopOfLibrary", "Explore", "Connive", "Reveal", "Sift"):
        dz = p.get("DestinationZone", "Hand" if a == "Dig" else "")
        impulse = bool(re.search(r"MayPlay\$|DB\$ Play\b", "\n".join(face.get("lines", []))))
        if a == "DigUntil" and _has(dfn + tgt, "Opponent", "Controller", "Targeted") and not _has(dfn, "You"):
            if _has(dz, "Battlefield"): out.add("steal" if _has(tgt, "Opponent") else "cheat")
        elif a in ("Dig", "DigUntil") and _has(dz, "Hand"):
            out.add("draw")
            if (_num(p.get("DigNum")) or 1) > (_num(p.get("ChangeNum")) or 1) or p.get("ChangeNum") == "All" and "ChangeValid" in p: out.add("select")
        elif a in ("Dig", "DigUntil") and _has(dz, "Battlefield"):
            out.add("cheat") if not _has(p.get("ChangeValid", ""), "Land") else out.add("landramp")
        elif a in ("Dig", "DigUntil") and _has(dz, "Exile") and impulse:
            out.add("draw")
        elif a in ("Dig", "DigUntil") and _has(dz, "Graveyard") and _has(dfn + tgt, "Opponent", "Player"):
            out.add("mill")
        elif a == "PeekAndReveal" and (_has(dfn + tgt, "Opponent") or p.get("PeekAmount", "1") == "1"): pass
        else: out.add("select")
        if a == "Explore": out.add("counters")
    elif a == "Investigate": out.add("draw")
    elif a == "ChangeZone":
        o, d, ct = p.get("Origin", "") or p.get("TgtZone", ""), p.get("Destination", ""), p.get("ChangeType", "") + tgt
        if _has(ct, "Plains", "Island", "Swamp", "Mountain", "Forest", "Desert", "Gate") and not _has(ct, "Creature", "nonLand"): ct += "|Land"
        land_search = any(_api(q) == "ChangeZone" and q.get("Origin") == "Library" and
                          _has(q.get("ChangeType", ""), "Land", "Plains", "Island", "Swamp", "Mountain", "Forest") for _, _, q in effects(face))
        if o == "Library" and d in ("Hand", "Battlefield") and "ChangeType" not in p and _has(dfn, "Remembered", "Imprinted") and land_search:
            out.add("landramp")   # the second half of "search for a land, then put it onto the battlefield or into your hand"
        elif o == "Library" and d == "Battlefield" and "ChangeType" not in p and _has(dfn, "Remembered", "Imprinted"):
            out.add("cheat")
        elif o == "Library" and d == "Hand" and "ChangeType" not in p and dfn and not dfn.startswith("Top"):
            out.add("draw")   # a card picked out of revealed cards
        elif o == "Library" and d == "Hand":
            if _has(ct, "Land") and not _has(ct, "nonLand"): out.add("landramp")
            elif dfn.startswith("Top") or p.get("Defined", "").startswith("TopOfLibrary"): out.add("draw")
            else: out.add("tutor")
        elif o == "Library" and d == "Library" and "ChangeType" in p and not _has(p.get("DefinedPlayer", "") + tgt, "Opponent", "Targeted", "Player"):
            if not (_has(ct, "Land") and not _has(ct, "nonLand")) and not _has(ct, "IsRemembered"): out.add("tutor")
            elif _has(ct, "Land") and not _has(ct, "IsRemembered") and not re.search(r"Defined\$ Remembered[^\n]*Origin\$ Library", "\n".join(face.get("lines", []))):
                out.add("select")
        elif o == "Library" and d == "Battlefield":
            if _has(p.get("DefinedPlayer", ""), "Targeted", "Opponent") or p.get("DefinedPlayer") == "Player.Opponent": pass   # the land goes to someone else
            elif _has(ct, "Land") and not _has(ct, "nonLand"): out.add("landramp")
            else: out.update(("tutor", "cheat"))
        elif _has(o, "Graveyard") and d == "Hand" and not (dfn or ct or tgt):
            out.add("resilient")   # the card returns itself
        elif _has(o, "Graveyard") and d == "Hand":
            if not selfish and not _has(dfn, "Self"): out.add("recursion")
            elif kind == "A" and _has(dfn, "Self") or selfish: out.add("resilient")
        elif _has(o, "Graveyard") and d == "Battlefield":
            if dfn == "Targeted" and not tgt: pass   # the targeting ability already counted
            elif (_has(dfn, "Self") or selfish or not (dfn or ct)) and not tgt: out.add("resilient")
            elif _has(ct, "Creature", "Permanent", "Card") or tgt: out.add("reanimate" if _has(ct, "Creature") or _has(tgt, "Creature") else "recursion")
            else: out.add("recursion")
        elif _has(o, "Graveyard") and d == "Library":
            if _has(tgt, "OppCtrl", "Opponent", "OppOwn") or _has(p.get("TgtPrompt", ""), "opponent") or (tgt and not _has(tgt, "YouOwn", "YouCtrl")): out.add("gyhate")
            elif _has(dfn, "Self", "TriggeredCard", "TriggeredNewCard") and _has(rootp.get("ValidCard", ""), "Self"): out.add("resilient")
            elif not selfish: out.add("recursion")
        elif _has(o, "Graveyard") and d == "Exile":
            if tgt or _has(dfn, "Targeted", "Opponent", "Player") or _has(p.get("TargetType", ""), "Graveyard"):
                if not _has(tgt, "YouOwn", "YouCtrl") and not _has(p.get("Cost", ""), "Exile"): out.add("gyhate")
        elif _has(o, "Sideboard") and d == "Hand": out.add("tutor")
        elif o == "Stack" and d in ("Exile", "Graveyard", "Library") and tgt: out.add("counter")
        elif _has(o, "Battlefield") and d in ("Exile", "Graveyard") and _has(p.get("Chooser", "") + p.get("DefinedPlayer", ""), "Targeted", "Opponent", "Player"):
            out.add("edict")
        elif _has(o, "Stack") and _has(o, "Battlefield") and d in ("Hand", "Library"):
            out.add("bounce" if d == "Hand" else "removal")
        elif o == "Battlefield" and d in ("Exile", "Library", "Hand") and _has(dfn, "TriggeredBlocker", "TriggeredAttacker", "TriggeredTarget", "TriggeredCard") and not _has(dfn, "Self"):
            out.add("bounce" if d == "Hand" else "removal")
        elif o == "Battlefield" and d in ("Exile", "Graveyard", "Library", "Hand") and not tgt and _has(dfn, "ChosenCard", "Remembered") and \
                (rootp.get("IsCurse") == "True" or _has(rootp.get("ValidTgts", ""), "Opponent", "Player")):
            out.add("bounce" if d == "Hand" else "removal")
        elif o == "Battlefield" and d in ("Exile", "Graveyard", "Library") and not selfish:
            if tgt and not _has(tgt, "YouCtrl") and not _has(tgt, "Card.YouOwn"):
                out.add("removal")
            elif not tgt and _has(dfn, "Targeted", "ChosenCard", "Remembered") and "Choices" not in p:
                pass
        elif _has(o, "Battlefield") and d == "Hand":
            if tgt and not _has(tgt, "YouCtrl") or (tgt and "Creature" in tgt and "YouCtrl" not in tgt): out.add("bounce")
        elif o == "Hand" and d in ("Library", "Graveyard", "Exile") and (_has(tgt + p.get("DefinedPlayer", "") + dfn, "Opponent", "Targeted", "Player") or _has(p.get("TgtPrompt", ""), "opponent")) and not _has(dfn, "You"):
            out.add("discard")
        elif o == "Hand" and d == "Battlefield":
            if _has(ct, "Land") and not _has(ct, "nonLand"): out.add("landramp")
            elif not selfish: out.add("cheat")
        elif _has(o, "Exile") and d == "Battlefield" and _has(dfn, "Remembered", "Targeted", "DelayTriggerRemembered", "Imprinted"):
            out.add("blink")
        elif _has(o, "Exile") and d == "Hand" and not selfish: pass
    elif a == "ChangeZoneAll":
        o, d, ct = p.get("Origin", ""), p.get("Destination", ""), p.get("ChangeType", "")
        if o == "Battlefield" and d in ("Exile", "Graveyard", "Hand", "Library") and _has(ct, "Creature", "Permanent", "Artifact", "Enchantment", "Planeswalker", "Land") and not _has(ct, "YouCtrl", "Self"):
            out.add("wipe")
        elif _has(o, "Graveyard") and d in ("Exile", "Library") and not _has(ct, "YouOwn", "YouCtrl") and not _has(p.get("Defined", ""), "You"):
            out.add("gyhate")
        elif _has(o, "Graveyard") and d in ("Hand", "Battlefield"):
            out.add("reanimate" if d == "Battlefield" and _has(ct, "Creature", "Permanent") else "recursion")
        elif o == "Library" and d == "Graveyard": out.add("mill")
        elif _has(o, "Exile") and d == "Battlefield" and _has(ct, "Remembered"): out.add("blink")
        if o == "Battlefield" and d == "Exile" and _has(ct, "YouCtrl") and _has(p.get("RememberChanged", ""), "True"): out.add("blink")
    elif a == "Destroy" and dfn == "Enchanted" and re.search(r"\bAura\b", face["types"]):
        out.add("removal")
    elif a in ("Destroy",) and not selfish:
        if tgt or _has(dfn, "Targeted", "ChosenCard", "Remembered", "TriggeredAttacker", "TriggeredBlocker", "Valid"): out.add("removal")
    elif a in ("DestroyAll", "SacrificeAll"):
        if not _has(p.get("ValidCards", ""), "Self", "YouCtrl") or a == "DestroyAll": out.add("wipe")
    elif a == "Sacrifice":
        if _has(dfn + tgt, "Opponent", "Player.Opponent", "Targeted", "Player", "TriggeredSourceController", "TriggeredCardController") and not _has(dfn, "You") and not selfish: out.add("edict")
    elif a in ("DealDamage", "EachDamage"):
        if selfish or _has(dfn, "You") and not tgt: pass
        else:
            hits = tgt + "|" + dfn + "|" + p.get("TargetType", "")
            if _has(dfn, "Controller", "TriggeredPlayer", "TriggeredTarget") and not _has(dfn, "You"): hits += "|Player"
            if dfn == "Remembered" and _has(rootp.get("RepeatPlayers", ""), "Opponent", "Player"): hits += "|Player"
            combat_trig = _has(dfn, "TriggeredAttacker", "TriggeredBlocker")
            if combat_trig: hits += "|Creature"
            creature = _has(hits, "Creature", "Any", "Planeswalker", "Permanent") or p.get("DividedAsYouChoose") or _has(p.get("DamageSource", ""), "Targeted")
            player = _has(hits, "Player", "Opponent", "Any")
            if creature and not _has(tgt, "YouCtrl"): out.add("removal")
            if player: out.add("burn")
            n = _num(p.get("NumDmg"))
            if rep and n is not None and 1 <= n <= 2 and (creature or player) and not combat_trig: out.add("pinger")
    elif a in ("DamageAll",):
        if _has(p.get("ValidCards", ""), "Creature"): out.add("wipe")
        if _has(p.get("ValidPlayers", ""), "Player", "Opponent"):
            out.add("burn")
            if rep and (_num(p.get("NumDmg")) or 0) in (1, 2): out.add("pinger")
    elif a == "Fight": out.add("removal")
    elif a in ("Pump",):
        att, de = p.get("NumAtt", ""), p.get("NumDef", "")
        kw = p.get("KW", "")
        if att == "Double" or _has(att, "Double"): out.add("double")
        if _has(kw, "power and toughness are switched", "SwitchPT"): out.add("swap")
        curse = p.get("IsCurse") == "True"
        if selfish:
            if kind == "A" and "AB" in rootp and (att.startswith("+") or de.startswith("+")):
                out.add("manasink" if _mana_cost(rootp.get("Cost", "")) else "buff")
            elif kind == "T" and (att.startswith("+") or de.startswith("+")) and not att.startswith("+0") or att.startswith("+X"): out.add("buff")
            if re.search(r"Hexproof|Indestructible|Shroud|Protection", kw): out.add("resilient")
            _kwlist_tags(kw, out)
            return
        if _has(kw, "doesn't untap") and (tgt or curse):
            out.add("tapper"); kw = ""
        if kw and not curse and not _has(kw, "power and toughness are switched"):
            got = set(); _kwlist_tags(kw, got)
            if "resilient" in got: got.discard("resilient"); got.add("protect")
            out |= got
        if (curse or tgt and not _has(tgt, "YouCtrl")) and _has(kw, "can't attack or block"): out.add("tapper")
        elif (curse or tgt and not _has(tgt, "YouCtrl")) and _has(kw, "can't block", "CARDNAME can't block"): out.add("evasion")
        if (att.startswith("-") and de.startswith("-")) or (de.startswith("-") and _num(de) is not None and _num(de) <= -2):
            if tgt or curse: out.add("removal")
        elif att.startswith("+") or de.startswith("+") or att.startswith("X") or _has(att, "+X"):
            if tgt or _has(dfn, "Targeted", "Enchanted", "Equipped", "TriggeredAttacker", "Remembered", "ChosenCard"):
                out.add("pump")
        if re.search(r"Hexproof|Indestructible|Shroud|Protection", kw) and not curse: out.add("protect")
        if re.search(r"Flying|Trample|Menace|Unblockable|Shadow|HIDDEN Unblockable|can't be blocked", kw) and not curse and not selfish: out.add("evasion") if tgt else None
        if curse and _has(kw, "can't block", "CARDNAME can't block"): pass
    elif a == "PumpAll":
        vc = p.get("ValidCards", "")
        att, de = p.get("NumAtt", ""), p.get("NumDef", "")
        kw = p.get("KW", "")
        if _has(vc, "YouCtrl") or (not _has(vc, "OppCtrl") and ((att.startswith("+") and not att.startswith("+0")) or de.startswith("+"))):
            if att.startswith("+") or de.startswith("+"): out.add("anthem")
            if re.search(r"Hexproof|Indestructible|Shroud|Protection", kw): out.add("protect")
            else: _kwlist_tags(kw, out)
        if de.startswith("-") and not _has(vc, "YouCtrl"): out.add("wipe")
    elif a in ("PutCounter", "PutCounterAll", "MultiplePiles"):
        ctype = p.get("CounterType", "")
        if ctype == "P1P1" or _has(" ".join(p), "Bolster", "Monstrosity", "Adapt", "Support"): out.add("counters")
        elif ctype == "M1M1" or re.match(r"^M\d+M\d+$", ctype):
            if a == "PutCounterAll" and not _has(p.get("ValidCards", ""), "YouCtrl"): out.add("wipe")
            elif tgt and not _has(tgt, "YouCtrl") and not selfish: out.add("removal")
    elif a == "Proliferate": out.add("proliferate")
    elif a in ("Token", "CopyPermanent", "Amass", "Incubate", "Populate"):
        if a == "CopyPermanent":
            out.add("clone"); out.add("tokens")
        else:
            ts = p.get("TokenScript", "")
            if _has(p.get("TokenOwner", ""), "Opponent", "Targeted", "Promised", "Chosen"): return
            matched = False
            for tag, keys in TOKEN_KIND:
                if any(k in ts for k in keys):
                    out.add(tag); matched = True
                    pass   # Treasure tokens are their own tag, not Mana generation
            if not matched or a != "Token": out.add("tokens")
    elif a in ("Clone",): out.add("clone")
    elif a in ("CopySpellAbility",): out.add("copy")
    elif a in ("Counter",): out.add("counter")
    elif a in ("Mana", "ManaReflected") and not is_land:
        out.add("ramp")
    elif a == "GainLife":
        if not _has(dfn, "Targeted", "TargetedController", "Opponent", "TriggeredCardController", "ParentTargetedController", "Player.Opponent", "RememberedController"):
            out.add("lifegain")
    elif a in ("LoseLife",):
        if _has(dfn + tgt, "Opponent", "Targeted", "Player", "Each") and not _has(dfn, "You") or (tgt and not dfn): out.add("drain")
    elif a == "Mill": out.add("mill")
    elif a == "Discard":
        if dfn == "Targeted" and _api(rootp) == "Draw": out.add("select")
        elif _has(dfn + tgt, "Opponent", "Targeted", "Player", "TriggeredTarget", "TriggeredPlayer") and not _has(dfn, "You"): out.add("discard")
        elif not dfn and not tgt and p.get("Mode") != "Hand": out.add("select")
        elif _has(dfn, "You") and p.get("Mode") != "Hand": out.add("select")
    elif a == "TapOrUntap" and not selfish: out.update(("tapper", "untap"))
    elif a == "Tap" and dfn == "Enchanted" and re.search(r"\bAura\b", face["types"]):
        out.add("tapper")
    elif a in ("Tap", "TapAll") and not selfish:
        if (tgt and not _has(tgt, "YouCtrl")) or (a == "TapAll" and not _has(p.get("ValidCards", ""), "YouCtrl")): out.add("tapper")
    elif a in ("Untap", "UntapAll") and not selfish:
        if _has(p.get("ValidCards", "") + tgt + dfn, "Land") and not _has(p.get("ValidCards", ""), "Creature"): out.add("ramp")
        else: out.add("untap")
    elif a in ("GainControl", "ExchangeControl", "ControlExchange", "ExchangeControlVariant"):
        if not (a == "GainControl" and p.get("NewController", "You") not in ("You", "")) and not _has(dfn, "Self"): out.add("steal")
    elif a == "AddTurn": out.add("extraturn")
    elif a == "AddPhase":
        if _has(p.get("ExtraPhase", ""), "Combat", "BeginCombat"): out.add("extracombat")
    elif a in ("Phases",): out.update(("phasing", "protect"))
    elif a in ("Regenerate", "RegenerateAll"):
        out.add("regen")
        if not selfish: out.add("protect")
        else: out.add("resilient")
    elif a in ("Protection", "ProtectionAll"):
        if not selfish: out.add("protect")
        else: out.add("resilient")
    elif a in ("PreventDamage", "PreventDamageAll"):
        if selfish: out.add("resilient")
        elif a == "PreventDamageAll" or _has(dfn, "Player.You", "You"): out.add("fog")
        elif not selfish: out.add("protect")
    elif a == "Fog": out.add("fog")
    elif a == "Animate" and p.get("IsCurse") == "True" and tgt and (_num(p.get("Power")) or 0) <= 1:
        out.add("removal")
    elif a == "Animate" and tgt and not _has(tgt, "OppCtrl") and _has(tgt, "Creature") and (_num(p.get("Power")) or 0) >= 3 and p.get("IsCurse") != "True":
        out.add("pump")
    elif a == "AnimateAll":
        vc = p.get("ValidCards", "")
        pw = _num(p.get("Power"))
        if (_has(vc, "Land") or not _has(vc, "Creature")) and not _has(vc, "OppCtrl", "TargetedPlayerCtrl"): out.add("animate")
        elif _has(vc, "OppCtrl", "TargetedPlayerCtrl") or p.get("IsCurse") == "True": out.add("wipe") if (pw is not None and pw <= 1) or "RemoveAllAbilities" in p else None
        elif _has(vc, "YouCtrl") and (pw is None or pw >= 2): out.add("anthem")
    elif a == "Animate":
        if selfish and re.search(r"\bCreature\b", face["types"]) and kind in ("A",): out.add("manasink")
        if re.search(r"\bPlaneswalker\b", face["types"]): pass
        elif is_land or selfish and not re.search(r"\bCreature\b", face["types"]): out.add("animate")
        elif tgt and (_has(tgt, "Land", "Forest", "Island", "Mountain", "Plains", "Swamp", "Artifact.nonCreature", "Permanent.nonCreature")): out.add("animate")
    elif a == "Goad": out.add("goad")
    elif a in ("BecomeMonarch", "TakeInitiative"): out.add("monarch")
    elif a == "Vote":
        out.add("vote")
        if _has(p.get("VoteCard", ""), "YouDontCtrl", "OppCtrl") and "Exile" in " ".join(face.get("lines", [])): out.add("removal")
    elif a in ("Play",):
        if p.get("WithoutManaCost") == "True": out.add("cheat")
        if _has(p.get("ValidZone", "") + p.get("Defined", "") + p.get("Valid", ""), "Graveyard"): out.add("recursion")
    elif a == "Discover": out.add("cheat")
    elif a == "Bounce": out.add("bounce")
    elif a in ("ChangeTargets",) and not selfish: out.add("protect")
    elif a == "Detain": out.add("tapper")


# ---------- rules text ----------
def _text(face):
    t = re.sub(r"\([^)]*\)", "", face.get("oracle", "") or "")
    return t


TEXT_RULES = [
    ("double", r"\bdouble (the |its |target creature's |each creature's )?power\b"),
    ("swap", r"\bswitch[^.]*\bpower and toughness\b"),
    ("pinger", r"\{T\}[^:]*: [^.]*deals 1 damage to (any target|target creature|target player|each opponent|target opponent|target creature or player)"),
    ("phasing", r"\bphases? out\b"),
    ("protect", r"\b(target|another target|each|all) (creatures?|permanents?)[^.]*you control (gains?|have|has) [^.]*\b(hexproof|indestructible|shroud|protection)\b"),
    ("lure", r"\bable to block [^.]* do so\b"),
    ("lure", r"\bmust be blocked\b"),
    ("extraturn", r"\bextra turn\b"),
    ("goad", r"\bgoad"),
    ("monarch", r"\b(the monarch|the initiative)\b"),
    ("vote", r"\bvote\b"),
    ("stax", r"\bspells? (your opponents cast |cost )[^.]*cost \{\d\} more\b"),
    ("stax", r"\bcan't attack you or (planeswalkers|a planeswalker) you control unless\b"),
    ("fog", r"\bprevent all combat damage\b(?! that would be dealt (by|to) (enchanted|equipped|CARDNAME))"),
    ("fog", r"\bprevent (that|the next \d+|the next|all)[^.]*damage[^.]*\b(to you|dealt to you|to creatures you control|to you and)"),
    ("landramp", r"\byou may play (an|two|up to (two|three)) additional lands?\b"),
    ("stax", r"\b(players|your opponents|each opponent|opponents) can't (search|cast|draw|untap|gain life|play|activate|attack)"),
    ("stax", r"\bmaximum hand size is reduced\b|\bno more than one creature can (attack|block)\b|\bcan't untap more than\b|\bwould cost less than three mana\b|\bcosts? \{\d\} more to (cast|activate)\b"),
    ("untap", r"\buntap all (permanents|creatures|lands|artifacts) you control\b"),
    ("protect", r"\b(spells|creature spells|noncreature spells) you (control|cast) can't be countered\b"),
    ("goad", r"\btarget creature attacks (this turn|each combat) if able\b"),
    ("fog", r"\bprevent (all|the next \d+|x of that|\d+ of that|that)(?![^.]*\b(to|by) (him|her|it|CARDNAME|enchanted|equipped)\b)[^.]*damage\b"),
    ("flash", r"\bas though it had flash\b|\bas though they had flash\b"),
    ("scaling", r"\b(power|toughness)( and toughness)? (is|are)( each)? equal to (the number|twice|your|its)|\b(CARDNAME|equipped creature|enchanted creature) gets [+-]\d+/[+-]\d+ for each\b"),
    ("discard", r"\bthat player discards (a|two|that many)\b"),
    ("stax", r"\b(your opponents control|opponents control) enter (the battlefield )?tapped\b"),
    ("stax", r"\b(creatures|permanents|artifacts|lands)\b[^.]* don't untap during (their|its controller's|your opponents')"),
    ("removal", r"\benchanted (creature|permanent) doesn't untap\b"),
    ("discard", r"\b(look at|reveals?) (target|each) (opponent's|player's) hand\b[^.]*\. [^.]*(choose|discard|exile|put)"),
    ("evasion", r"\bcan't be blocked\b"),
    ("treasure", r"\bTreasure\b"),
    ("edict", r"\b(each|target) (opponent|player) sacrifices (a|an|two|three|x)\b"),
    ("wipe", r"\b(destroy|exile) all (other )?(creatures|nonland permanents|permanents|artifacts|enchantments|planeswalkers)\b"),
    ("counter", r"\bcounter target (spell|activated|triggered|creature spell|noncreature spell|instant|artifact)\b"),
    ("tutor", r"\bsearch your library for an? (?!(basic )?land card|basic)[^.]*card"),
    ("draw", r"(?<!whenever you )(?<!would )(?<!you would )\bdraw (a|two|three|four|x|that many) (additional )?cards?\b"),
    ("burn", r"\bdeals? (\d+|x) damage to (that player|each player|each opponent|target player|target opponent|any target)\b"),
    ("counters", r"\bdouble the number of (each kind of )?counters\b"),
    ("goad", r"\b(target creature|all creatures|each creature)[^.]* attacks? [^.]*(this turn|each combat) if able\b"),
    ("lure", r"\b(target creature|all creatures)[^.]* blocks? [^.]*(this turn|each combat) if able\b"),
    ("stax", r"\bmaximum hand size is (one|two|three|four|reduced)\b"),
]
TEXT_RULES = [(k, re.compile(p, re.I)) for k, p in TEXT_RULES]
# a text rule is only a fallback: when the script already has the matching effect, the script's reading wins
SCRIPT_OWNS = {"draw": {"Draw", "Event:Draw"}, "discard": {"Discard"}, "tutor": {"ChangeZone"}, "counter": {"Counter"},
               "edict": {"Sacrifice", "SacrificeAll"}, "burn": {"DealDamage", "DamageAll"}, "fog": {"PreventDamage", "PreventDamageAll", "Fog", "Event:DamageDone"},
               "wipe": {"DestroyAll", "ChangeZoneAll", "DamageAll", "PumpAll"}, "treasure": {"Token"}}
NOT_CREATURE = {"Clue", "Food", "Treasure", "Blood", "Map", "Gold", "Powerstone", "Equipment", "Vehicle", "Fortification", "Contraption",
                "Attraction", "Incubator", "Junk", "Bobblehead", "Spacecraft", "Lander", "Aura", "Cartouche", "Class", "Curse", "Rune", "Saga",
                "Shard", "Shrine", "Background", "Case", "Room", "Role", "Plan", "Forest", "Island", "Mountain", "Plains", "Swamp", "Desert",
                "Gate", "Lair", "Locus", "Mine", "Power-Plant", "Tower", "Urza's", "Cave", "Sphere", "Town", "Planet", "Omen", "Book"}
SUPER = {"Legendary", "Basic", "Snow", "World", "Kindred", "Tribal", "Artifact", "Creature", "Enchantment", "Instant", "Sorcery",
         "Planeswalker", "Land", "Battle", "Ongoing", "Elite", "Host", "Conspiracy", "Phenomenon", "Plane", "Scheme", "Vanguard", "Dungeon"}
IRREG = {"Elf": "Elves", "Wolf": "Wolves", "Dwarf": "Dwarves", "Mouse": "Mice", "Ox": "Oxen", "Fungus": "Fungi", "Homunculus": "Homunculi",
         "Cyclops": "Cyclopes", "Sphinx": "Sphinxes", "Fox": "Foxes", "Lich": "Liches", "Octopus": "Octopi", "Werewolf": "Werewolves",
         "Thief": "Thieves", "Leech": "Leeches", "Djinn": "Djinn", "Efreet": "Efreet", "Sheep": "Sheep", "Fish": "Fish", "Moonfolk": "Moonfolk",
         "Merfolk": "Merfolk", "Kithkin": "Kithkin", "Elk": "Elk", "Hero": "Heroes", "Pegasus": "Pegasi", "Ninja": "Ninja", "Samurai": "Samurai"}
_kindred_re = None


def kindred_setup(pool):
    """Creature types from the pool -> one regex for type-caring text (case-sensitive: 'Elves you control', 'other Goblins')."""
    global _kindred_re
    types = set()
    for c in pool:
        for f in c["faces"]:
            w = f["types"].split()
            if "Creature" in w or "Kindred" in w or "Tribal" in w:
                types.update(x for x in w if x not in SUPER and x[:1].isupper())
    types -= {"Wall"} | NOT_CREATURE   # "Wall" mostly shows up as "non-Wall creature"
    forms = set()
    for t in types:
        if t in IRREG: pl = IRREG[t]
        elif re.search(r"[^aeiou]y$", t): pl = t[:-1] + "ies"
        elif t.endswith(("s", "x", "ch", "sh")): pl = t + "es"
        else: pl = t + "s"
        forms.add(t); forms.add(pl)
    alt = "|".join(sorted((re.escape(x) for x in forms), key=len, reverse=True))
    I = lambda w: "(?i:%s)" % w
    _kindred_re = re.compile((r"(\b(%s)?(%s)( creatures?| spells?| cards?| permanents?)? (you control|you cast|get \+|have |gain |can't|deal|are )|"
                              r"\b(%s) (creature )?(spells?|cards?) (you cast )?cost\b|\b%s (other )?(%s)( creatures?)? (you control )?(enters|dies|attacks|deals)|"
                              r"\b%s (%s)\b|\b%s (other )?(%s)( creatures?)?( you control| on the battlefield)\b|"
                              r"\b(%s) (creature )?(spells|cards|creatures|permanents)\b|\b%s (%s)( or (%s))?\b(?! (creature )?tokens?)|"
                              r"\b%s (other )?(%s)\b|\b%s (%s)( creature)?\b|\b(a|an) (%s) or (%s) (creature )?(card|spell)\b|\bwith one or more (%s)\b|"
                              r"\b%s\b|\bcreatures? of the chosen type\b|\bshares a creature type\b)")
                             % (I("other |each |another |nontoken "), alt, alt, I("whenever (a|another|one or more)"), alt, I("search your library for an?"), alt,
                                I("for each"), alt, alt, I("another|other"), alt, alt, I("control (a|an|another|two or more|three or more|five or more|no)"), alt,
                                I("target"), alt, alt, alt, alt, I("choose a creature type")))


def _selfname(card, t):
    for nm in sorted({card["name"], card.get("front", card["name"])} | {f.get("name", "") for f in card["faces"]}, key=len, reverse=True):
        for part in nm.split(" // "):
            if part.strip():
                t = t.replace(part.strip(), "CARDNAME")
                if "," in part: t = t.replace(part.split(",")[0].strip(), "CARDNAME")
    return t


def kindred_text(card, t):
    """Text for the kindred check: the card's own name and P/T token or animation descriptions removed, opponents' boards dropped."""
    t = _selfname(card, t)
    t = re.sub(r"\b[\dX*]+/[\dX*]+ [^.,]*?\bcreatures?\b( tokens?)?", " ", t)
    t = re.sub(r"\b(defending player|an opponent|each opponent|target opponent|that player) controls?\b[^.]*", " ", t)
    return t


# ---------- lands ----------
def land_tags(card, produced):
    out = set()
    f0 = card["faces"][0]
    if not re.search(r"\bLand\b", f0["types"]): return out
    if re.search(r"\bBasic\b", f0["types"]):
        out.add("basic"); return out
    eff = effects(f0)
    nonmana = [e for e in eff if (_api(e[2]) not in (None, "Mana", "ManaReflected") or (e[0] == "T" and _api(e[2]) is None and e[2].get("Mode") not in ("ChangesZone",)))]
    fetch = any(_api(p) == "ChangeZone" and p.get("Origin") == "Library" and _has(p.get("ChangeType", ""), "Land", "Plains", "Island", "Swamp", "Mountain", "Forest") for _, _, p in eff)
    if len(produced or "") >= 2 or fetch or re.search(r"\bany color\b|mana of any|choose a (basic land|color)", f0["oracle"] or ""): out.add("fixing")
    def minor(p):
        a = _api(p)
        return a in ("Mana", "ManaReflected", "ChangeZone", "Tap", "GainLife", "ChooseType", "ChooseColor", "Cleanup", "StoreSVar") or \
            (a == "Pump" and _has(p.get("KW", ""), "untap")) or (a == "LoseLife" and _has(p.get("Defined", ""), "You")) or \
            (a == "DealDamage" and _has(p.get("Defined", ""), "You"))
    oracle = f0["oracle"] or ""
    if any(not minor(p) for _, _, p in eff if _api(p)) or \
            (re.search(r"\{T\}[^:]*: (?!Add)", oracle) and not fetch) or re.search(r"^Landfall|cycling|channel", oracle, re.I | re.M):
        out.add("utilityland")
    if not out: out.add("monoland")
    return out


# ---------- one card ----------
def tag_card(card, produced=""):
    out, why = set(), []
    for fi, face in enumerate(card["faces"]):
        if fi > 0 and card.get("alt") not in ("Modal", "Split", "Transform", "DoubleFaced", "Adventure", "Flip", "Omen", "Prepare"):
            continue
        for kind, rootp, p in effects(face):
            _effect_tags(card, face, kind, rootp, p, out, why)
            # an activated ability that costs another creature or artifact is a sacrifice outlet
            if kind == "A" and "AB" in rootp and p is rootp or (kind == "A" and p == rootp):
                cost = rootp.get("Cost", "")
                if re.search(r"Sac<(\d+|X)/(?!Treasure|Food|Clue|Blood|Map|Powerstone|Gold|Junk|Incubator|Shard)(Creature|Artifact|Permanent|Land|Enchantment|Token|[A-Z][a-z]+)(?!\.Self)", cost) and not re.search(r"Sac<\d+/CARDNAME>|Sac<1/Card\.Self>", cost):
                    out.add("sacoutlet")
        for k in keywords(face):
            _kw_tags(k, out)
        t = _text(face)
        tn = _selfname(card, t)
        apis = set()
        for _, _, p in effects(face):
            a = _api(p)
            if a: apis.add(a)
            elif "Event" in p: apis.add("Event:" + p["Event"])
        for key, rx in TEXT_RULES:
            if rx.search(tn) and not (SCRIPT_OWNS.get(key, set()) & apis): out.add(key)
        if _kindred_re is not None and _kindred_re.search(kindred_text(card, t)):
            out.add("kindred")
        ty = face["types"]
        if re.search(r"\bAura\b", ty): out.add("aura")
        if re.search(r"\bEquipment\b", ty): out.add("equipment")
        if re.search(r"\bVehicle\b", ty): out.add("vehicle")
        if re.search(r"\b(Saga|Class|Case|Room)\b", ty): out.add("saga")
        if re.search(r"\bPlaneswalker\b", ty): out.add("planeswalker")
        if re.search(r"\bCreature\b", ty) and not t.strip() and not keywords(face) and fi == 0: out.add("vanilla")
    DRAWBACKS = [r"(CARDNAME|this creature) (can't attack|can't block|can't attack or block)\b[^.]*\.",
                 r"(CARDNAME|this creature) (attacks|blocks) each (combat|turn) if able\b[^.]*\.",
                 r"(CARDNAME|this creature) enters tapped\.", r"(CARDNAME|this creature) doesn't untap during your untap step\.",
                 r"At the beginning of your upkeep, sacrifice (CARDNAME|this creature) unless you [^.]*\.",
                 r"When you control no [^,.]+, sacrifice (CARDNAME|this creature)\.", r"(CARDNAME|this creature) can block only creatures with flying\.",
                 r"At the beginning of your upkeep, you lose \d+ life[^.]*\.", r"As an additional cost to cast this spell, [^.]*\.",
                 r"^(Cumulative upkeep|Echo|Fading|Vanishing)[^\n]*", r"CARDNAME can't be blocked except by[^.]*\."]
    COSTKW = ("Madness", "Morph", "Megamorph", "Disguise", "Kicker", "Echo", "Cumulative upkeep", "Evoke", "Suspend", "Emerge", "Dash", "Crew",
              "Foretell", "Plot", "Warp", "Devoid", "Delve", "Convoke", "Improvise", "Affinity", "Undaunted", "Assist", "Ninjutsu", "Mutate", "Squad", "Station", "Prototype", "Impending", "Bargain", "Spectacle", "Surge", "Prowl")
    f0 = card["faces"][0]
    if re.search(r"\b(Creature|Vehicle)\b", f0["types"]) and not (out - TYPE_ONLY - {"vehicle"}) and all(k.split(":")[0] in COSTKW for k in keywords(f0)) \
            and not re.sub(r"\([^)]*\)", "", re.sub(r"^(%s)\b.*$" % "|".join(COSTKW), "", f0["oracle"] or "", flags=re.M)).strip():
        out.add("vanilla")
    if re.search(r"\bCreature\b", f0["types"]) and not (out - TYPE_ONLY - {"vanilla", "keyword", "evasion"}) and "vanilla" not in out:
        rest = _selfname(card, _text(f0))
        for rx in DRAWBACKS: rest = re.sub(rx, "", rest, flags=re.M | re.I)
        rest = re.sub(r"^(%s)\b[^\n]*$" % "|".join(COSTKW), "", rest, flags=re.M)
        rest = re.sub(r"^(Flying|Trample|Menace|Reach|Vigilance|Haste|Defender|First strike|Deathtouch|Lifelink)(, [a-z ]+)*$", "", rest, flags=re.M)
        if not rest.strip() and not out: out.add("vanilla")
    out |= land_tags(card, produced)
    # a land's own mana ability isn't ramp; a ramp tag on a land only comes from fetching or extra land drops
    if re.search(r"\bLand\b", card["types"]):
        out.discard("ramp"); out.discard("landramp")
    # untargeted "destroy" chains (e.g. Imperial Edict: opponent chooses, destroy that creature) read as edicts
    return out


def load_overrides():
    p = os.path.join(HERE, "reviews", "tags.tsv")
    out = {}
    if not os.path.exists(p): return out
    with open(p, encoding="utf-8") as fh:
        lines = fh.read().split("\n")
    for n, line in enumerate(lines, 1):
        if not line.strip() or line.startswith("#"): continue
        name, _, rest = line.partition("\t")
        changes = rest.split("\t")[0].split()
        for ch in changes:
            if ch[0] not in "+-" or ch[1:] not in LABEL: raise SystemExit("reviews/tags.tsv line %d: bad change %r" % (n, ch))
        out[name.strip()] = changes
    return out


def load_ai_tags():
    """reviews/tags-ai.tsv: name<TAB>new tags<TAB>downsides, from the merged tagging run (tags-new.tsv).
    Only AI_ONLY keys are read; hand fixes in reviews/tags.tsv still win (-selfmill removes one)."""
    p = os.path.join(HERE, "reviews", "tags-ai.tsv")
    out = {}
    if not os.path.exists(p): return out
    with open(p, encoding="utf-8") as fh:
        lines = fh.read().split("\n")
    for n, line in enumerate(lines, 1):
        if not line.strip() or line.startswith("#") or line.startswith("name\t"): continue
        name, _, rest = line.partition("\t")
        keys = " ".join(rest.split("\t")[:2]).split()
        for k in keys:
            if k not in AI_ONLY: raise SystemExit("reviews/tags-ai.tsv line %d: %r isn't one of the AI tags" % (n, k))
        out[name.strip()] = set(keys)
    return out


def tag_pool(pool, produced_of):
    kindred_setup(pool)
    ov = load_overrides()
    ai = load_ai_tags()
    res = {}
    for c in pool:
        tags = tag_card(c, produced_of(c))
        tags |= ai.get(c["name"], ai.get(c["front"], set()))
        for ch in ov.get(c["name"], ov.get(c["front"], [])):
            (tags.add if ch[0] == "+" else tags.discard)(ch[1:])
        res[c["name"]] = sorted(tags, key=lambda k: ORDER[k])
    return res


def coverage(tags):
    n = len(tags)
    job = sum(1 for v in tags.values() if set(v) - TYPE_ONLY - DOWNSIDES)
    return job / n if n else 0.0


# ---------- accuracy against the hand-labeled sample ----------
def read_gold(path):
    gold = {}
    if not os.path.exists(path): return gold
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().split("\n")
    for line in lines:
        if not line.strip() or line.startswith("#") or line.startswith("name\t"): continue
        name, _, rest = line.partition("\t")
        gold[name] = set(rest.split("\t")[0].split())
    return gold


def score(tags, gold):
    """Micro precision and recall over the gold cards, plus per-tag numbers."""
    tp = fp = fn = 0
    per = defaultdict(lambda: [0, 0, 0])
    for name, want in gold.items():
        got = set(tags.get(name, [])) - AI_ONLY
        for k in got & want: tp += 1; per[k][0] += 1
        for k in got - want: fp += 1; per[k][1] += 1
        for k in want - got: fn += 1; per[k][2] += 1
    prec = tp / (tp + fp) if tp + fp else 1.0
    rec = tp / (tp + fn) if tp + fn else 1.0
    covered = sum(1 for name, want in gold.items() if (set(tags.get(name, [])) - AI_ONLY) & (want - TYPE_ONLY)) / max(1, sum(1 for w in gold.values() if w - TYPE_ONLY))
    return dict(precision=prec, recall=rec, covered=covered, per=dict(per), n=len(gold))
