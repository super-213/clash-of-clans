"""Build a reviewable rule snapshot from pinned ClashKing game-data exports.

Download buildings/troops/spells/heroes/pets/equipment.json into a directory,
then run: python -m atlas.build_rules DIRECTORY --reviewed-on YYYY-MM-DD
Review the diff against Supercell release notes before committing it.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path

REVISION = "b8f42a707fe92d5293d46088bf536450ae422e7b"
ROOT = Path(__file__).resolve().parents[2]


def build(directory: Path, reviewed_on: str) -> dict:
    data, hashes = {}, {}
    for name in ("buildings", "troops", "spells", "heroes", "pets", "equipment"):
        raw = (directory / f"{name}.json").read_bytes()
        data[name] = json.loads(raw)["items"]
        hashes[name] = hashlib.sha256(raw).hexdigest()
    buildings = {b["name"]: b for b in data["buildings"] if b.get("village") == "home"}
    stock, halls = Counter({"Town Hall": 1}), {}
    # Fully placed contemporary layouts; merges consume their original buildings.
    for hall in buildings["Town Hall"]["levels"]:
        level = hall["level"]
        stock.update({b["name"]: b["quantity"] for b in hall["unlocks"]})
        expected = stock.copy()
        # The August 2026 season extended the station to TH11+. The static
        # town-hall unlock table still lists its original TH18 unlock.
        if level >= 11:
            expected["Crafting Station"] = 1
        for merged, original in (("Multi-Archer Tower", "Archer Tower"),
                                 ("Ricochet Cannon", "Cannon"),
                                 ("Super Wizard Tower", "Wizard Tower")):
            expected[original] -= 2 * expected[merged]
        if level >= 17:
            expected["Eagle Artillery"] = 0
            expected["Archer Tower"] -= expected["Multi-Gear Tower"]
            expected["Cannon"] -= expected["Multi-Gear Tower"]
        # Builders are purchased/unlocked separately, not a structural version signal.
        for optional in ("Builder's Hut", "B.O.B's Hut"):
            expected.pop(optional, None)
        halls[str(level)] = {k: v for k, v in sorted(expected.items()) if v > 0}

    troops = {x["_id"]: x for x in data["troops"]}

    def unlock(item):
        building = buildings.get(item.get("production_building"))
        if building and building["levels"]:
            levels = [v["required_townhall"] for v in building["levels"]
                      if v["level"] >= item.get("production_building_level", 1)]
            minimum = min(levels) if levels else 50
        else:
            minimum = min(v.get("required_townhall", 50) for v in item["levels"])
        if item.get("super_troop"):
            base = troops[item["super_troop"]["original_id"]]
            minimum = max(11, minimum, min(v["required_townhall"] for v in base["levels"]
                          if v["level"] >= item["super_troop"]["original_min_level"]))
        return minimum

    units = {}
    # Permanent trainable home units. Event units are deliberately absent until
    # their availability window has been independently reviewed.
    permanent = {0,1,2,3,4,5,6,7,8,9,10,11,12,13,15,17,22,23,24,26,27,28,29,
                 51,52,53,55,56,57,58,59,62,63,64,65,66,75,76,80,81,82,83,84,
                 87,91,92,95,97,98,109,110,123,132,135,147,150,177,188}
    for group, offset in (("troops", 4000000), ("spells", 26000000),
                          ("heroes", 28000000), ("pets", 73000000), ("equipment", 90000000)):
        for item in data[group]:
            if item.get("village", "home") != "home" or not item["levels"]:
                continue
            short = item["_id"] - offset
            if group == "troops" and short not in permanent:
                continue
            if group == "spells" and short in (6, 73):
                continue
            kind = {"troops": "troop", "spells": "spell", "heroes": "hero",
                    "pets": "pet", "equipment": "equipment"}[group]
            if item.get("production_building") == "Workshop":
                kind = "siege"
            key = f'{"s" if group == "spells" else "h" if group == "heroes" else "p" if group == "pets" else "e" if group == "equipment" else "u"}{short}'
            units[key] = {"name": item["name"], "group": kind,
                          "min_hall": 10 if kind == "siege" else unlock(item),
                          "housing": item.get("housing_space", 0)}
            if item.get("hero"):
                units[key]["hero"] = item["hero"]
    capacities = [20,30,70,80,135,150,200,200,220,240,260,280,300,300,320,320,340,360]
    spells = [0,0,0,0,2,4,6,7,9,11,11,11,11,11,11,11,11,11]
    rules = {"reviewed_on": reviewed_on,
            "data_revision": REVISION,
            "data_source": f"https://github.com/ClashKingInc/ClashKingAssets/tree/{REVISION}/assets/static_data",
            "source_sha256": hashes,
            "release_notes": [
                "https://supercell.com/en/games/clashofclans/blog/release-notes/town-hall-18-crash-lands-update/",
                "https://supercell.com/en/games/clashofclans/blog/release-notes/the-anime-fury-update-is-here/",
                "https://supercell.com/en/games/clashofclans/blog/release-notes/may-update/",
                "https://supercell.com/en/games/clashofclans/blog/news/the-awesome-quest-is-here/",
                "https://supercell.com/en/games/clashofclans/blog/news/weve-revamped-the-clash-of-clans-user-interface/"],
            "buildings": halls, "optional_buildings": {"Builder's Hut": 5, "B.O.B's Hut": 1},
            "crafted_defenses": [x["name"] for x in buildings["Crafting Station"]["seasonal_defenses"]],
            "units": units,
            "capacity": {str(h): {"troop": capacities[h-1], "spell": spells[h-1], "siege": 3,
                                    "hero": 4 if h >= 13 else 3 if h >= 11 else 2 if h >= 9 else 1 if h >= 4 else 0}
                         for h in range(1, 19)}}
    checksum = hashlib.sha256(json.dumps(rules, sort_keys=True).encode()).hexdigest()[:12]
    return {"version": f"home-{reviewed_on}-{checksum}", **rules}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--reviewed-on", required=True)
    args = parser.parse_args()
    (ROOT / "shared/game-rules.json").write_text(
        json.dumps(build(args.directory, args.reviewed_on), ensure_ascii=False, indent=2) + "\n")
