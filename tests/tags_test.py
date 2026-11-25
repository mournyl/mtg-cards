"""Tag detector checks on real Forge scripts (tests/tags-fixtures.json), no Forge download needed.
   python3 tests/tags_test.py
The full-pool checks (coverage, precision on tests/tags-gold.tsv) run inside tools/tiers/build.py."""
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools", "tiers"))
import tags as TG  # noqa: E402

CARDS = json.load(open(os.path.join(ROOT, "tests", "tags-fixtures.json"), encoding="utf-8"))
TG.kindred_setup(list(CARDS.values()) + [{"faces": [{"types": t}]} for t in ("Creature Elf Druid", "Creature Goblin", "Creature Human")])
PRODUCED = {"Flooded Strand": ""}


def tags(name):
    return TG.tag_card(CARDS[name], PRODUCED.get(name, ""))


class Tags(unittest.TestCase):
    def has(self, name, *want, no=()):
        got = tags(name)
        for k in want: self.assertIn(k, got, "%s should be tagged %s, got %s" % (name, k, sorted(got)))
        for k in no: self.assertNotIn(k, got, "%s should not be tagged %s, got %s" % (name, k, sorted(got)))

    def test_requested_examples(self):
        self.has("Twisted Image", "draw", "swap")
        self.has("Bulk Up", "double")
        self.has("Reality Ripple", "protect", "phasing")
        self.has("Prodigal Pyromancer", "pinger", "removal")
        self.has("Kessig Flamebreather", "pinger", "spellpayoff")
        self.has("Slip Out the Back", "protect", "phasing")

    def test_scripts_beat_wording(self):
        self.has("Vex", "counter", no=("draw",))                 # the opponent draws, not you
        self.has("Liliana's Shade", "landramp", no=("tutor", "ramp"))       # a Swamp card is a land
        self.has("Kessig Forgemaster", "removal", no=("pinger",))  # block damage isn't a pinger
        self.has("Lightning Greaves", "protect", "haste", no=("resilient",))
        self.has("Cultivate", "landramp", no=("tutor", "ramp"))
        self.has("Enlightened Tutor", "tutor")
        self.has("Rhystic Study", "draw", no=("spellpayoff",))   # triggers on opponents' spells
        self.has("Flooded Strand", "fixing", no=("tutor", "cheat", "utilityland"))

    def test_statics_and_chains(self):
        self.has("Wild Nacatl", "buff")
        self.has("In Bolas's Clutches", "steal")
        self.has("Pacifism", "removal")
        self.has("Chameleon Blur", "fog")
        self.has("Rishadan Footpad", "edict")
        self.has("Typhoon", "burn")
        self.has("Council's Judgment", "removal", "vote")
        self.has("Ghoulsteed", "resilient", no=("recursion",))
        self.has("Elvish Archdruid", "ramp", "anthem", "kindred")
        self.has("Opt", "draw", "select")

    def test_ramp_split(self):
        self.has("Elvish Archdruid", "ramp", no=("landramp", "treasure"))   # mana generation
        self.has("Rishadan Footpad", no=("ramp",))

    def test_bodies(self):
        self.has("Grizzly Bears", "vanilla")
        self.has("Wolf Cove Villager", "vanilla")   # only a drawback

    def test_overrides_file_is_valid(self):
        TG.load_overrides()   # raises on a bad line

    def test_ai_tags_file_is_valid(self):
        ai = TG.load_ai_tags()   # raises on a key that isn't one of the AI-only tags
        for name, ks in ai.items(): self.assertTrue(ks <= TG.AI_ONLY, name)

    def test_tag_codes_fit(self):
        src = open(os.path.join(ROOT, "tools", "tiers", "build.py"), encoding="utf-8").read()
        ns = {}
        exec(src[src.index("TAG_CODE = ("):src.index("\n", src.index("room for 108")) + 1], ns)
        self.assertEqual(len(ns["TAG_CODE"]), len(set(ns["TAG_CODE"])))
        self.assertGreaterEqual(len(ns["TAG_CODE"]), len(TG.KEYS))

    def test_gold_files_parse(self):
        for f in ("tags-gold.tsv", "tags-holdout.tsv"):
            gold = TG.read_gold(os.path.join(ROOT, "tests", f))
            self.assertGreaterEqual(len(gold), 200, f)
            for name, ks in gold.items():
                self.assertTrue(ks <= set(TG.KEYS), "%s: %s has unknown tags %s" % (f, name, ks - set(TG.KEYS)))


if __name__ == "__main__":
    unittest.main(verbosity=1)
