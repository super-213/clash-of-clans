"""Content compatibility, separate from URL validity and link expiry.

Layout IDs are opaque references, not building inventories. Only exact,
reviewed per-layout evidence can establish structural compatibility.
"""
from __future__ import annotations

from collections import Counter
import json
from pathlib import Path
import re
from urllib.parse import parse_qs, urlsplit

from .models import fingerprint

RULES = json.loads((Path(__file__).resolve().parents[2] / "shared/game-rules.json").read_text())
HERO = r"\d+(?:m[01])?(?:p\d+)?(?:e\d+(?:_\d+)?)?"
SECTIONS = re.compile(rf"h{HERO}(?:-{HERO})*|[usid]\d+x\d+(?:-\d+x\d+)*")


def load_evidence(path: Path) -> dict:
    raw = json.loads(path.read_text())
    if raw.get("rules_version") != RULES["version"]:
        # Evidence for an older inventory cannot certify a new release.
        return {}
    return raw["layouts"]


def normalized(name):
    name = name.replace("Heal Spell", "Healing Spell")
    return re.sub(r"[^a-z0-9]", "", name.lower())


def assess(record: dict, evidence: dict | None = None) -> dict:
    def result(status, *reasons, evidence_url=None):
        return {"status": status, "rules_version": RULES["version"],
                "reasons": list(reasons), "evidence_url": evidence_url}

    hall = str(record["town_hall"])
    if record["village"] != "home" or hall not in RULES["buildings"]:
        return result("unknown", "unsupported_hall_or_village")
    if record["kind"] == "base":
        if not record.get("game_link"):
            return result("unknown", "missing_layout_link")
        proof = (evidence or {}).get(fingerprint(record))
        payload = parse_qs(urlsplit(record["game_link"]).query)["id"][0]
        if not proof or proof.get("layout_id") != payload or proof.get("image_url") != record["image_url"]:
            return result("unknown", "missing_exact_building_inventory")
        evidence_url = proof.get("evidence_url", "")
        if not evidence_url.startswith("https://") or proof.get("method") not in ("game-export", "reviewed-image"):
            return result("unknown", "invalid_inventory_evidence")
        inventory = proof.get("buildings")
        if not isinstance(inventory, dict) or any(type(v) is not int or v < 0 for v in inventory.values()):
            return result("unknown", "invalid_building_inventory")
        inventory = dict(inventory)
        if int(hall) >= 11:
            for name in RULES["crafted_defenses"]:
                if name in inventory:
                    inventory["Crafting Station"] = inventory.get("Crafting Station", 0) + inventory.pop(name)
        expected = RULES["buildings"][hall]
        reasons = [f"building_count:{name}:expected={count}:actual={inventory.get(name, 0)}"
                   for name, count in expected.items() if inventory.get(name, 0) != count]
        for name, count in inventory.items():
            if name in RULES["optional_buildings"]:
                if count > RULES["optional_buildings"][name]:
                    reasons.append(f"excess_optional_building:{name}")
            elif name not in expected and count:
                reasons.append(f"removed_or_unavailable_building:{name}")
        return result("incompatible" if reasons else "compatible", *reasons, evidence_url=evidence_url)

    payload = parse_qs(urlsplit(record["game_link"]).query).get("army", [""])[0]
    sections = [m.group() for m in SECTIONS.finditer(payload)]
    if not sections or "".join(sections) != payload or len({s[0] for s in sections}) != len(sections):
        return result("unknown", "unsupported_army_encoding")
    selected, heroes, issues, unknown = Counter(), [], [], []
    for section in sections:
        prefix = section[0]
        if prefix == "h":
            for raw in section[1:].split("-"):
                hero_id = re.match(r"\d+", raw)[0]
                hero = "h" + hero_id
                heroes.append(hero)
                selected[hero] += 1
                for kind, value in re.findall(r"([pe])(\d+(?:_\d+)*)", raw):
                    for item in value.split("_"):
                        selected[kind + item] += 1
                        equipment = RULES["units"].get(kind + item)
                        if kind == "e" and equipment and equipment.get("hero") != RULES["units"].get(hero, {}).get("name"):
                            issues.append(f"equipment_hero_mismatch:{hero}:{kind + item}")
        else:
            for pair in section[1:].split("-"):
                count, unit_id = map(int, pair.split("x"))
                if not 1 <= count <= 1000:
                    issues.append("invalid_unit_count")
                key = ("s" if prefix in "sd" else "u") + str(unit_id)
                if prefix in "id":
                    # Reinforcement unlock/capacity rules differ from own army.
                    # Retain these separately until Clan Castle rules are supported.
                    unknown.append("reinforcement_rules_unverified")
                    if key not in RULES["units"]:
                        unknown.append(f"unknown_unit:{key}")
                    continue
                if key in selected:
                    issues.append(f"duplicate_unit:{key}")
                selected[key] += count
    totals = Counter()
    for key, count in selected.items():
        rule = RULES["units"].get(key)
        if not rule:
            unknown.append(f"unknown_or_event_unit:{key}")
            continue
        if rule["min_hall"] > int(hall):
            issues.append(f"unit_not_unlocked:{rule['name']}:TH{rule['min_hall']}")
        group = rule["group"]
        if group in ("pet", "equipment") and count > 1:
            issues.append(f"duplicate_{group}:{rule['name']}")
        totals[group] += count * (rule["housing"] if group in ("troop", "spell") else 1)
    if not totals["troop"]:
        issues.append("missing_army_troops")
    if len(heroes) != len(set(heroes)):
        issues.append("duplicate_hero")
    for group in ("troop", "spell", "siege", "hero"):
        if totals[group] > RULES["capacity"][hall][group]:
            issues.append(f"capacity_exceeded:{group}:{totals[group]}>{RULES['capacity'][hall][group]}")

    by_name = {normalized(v["name"]): (k, v) for k, v in RULES["units"].items()}
    displayed, linked = Counter(), Counter()
    for unit in record.get("units", []):
        match = by_name.get(normalized(unit["name"]))
        if not match:
            unknown.append(f"unknown_source_unit:{unit['name']}")
            continue
        key, rule = match
        if rule["group"] != unit["group"]:
            issues.append(f"source_unit_group_mismatch:{unit['name']}")
        if rule["min_hall"] > int(hall):
            issues.append(f"source_unit_not_unlocked:{unit['name']}")
        if unit["group"] in ("troop", "spell", "siege"):
            displayed[key] += unit["count"]
    for key, count in selected.items():
        if RULES["units"].get(key, {}).get("group") in ("troop", "spell", "siege"):
            linked[key] += count
    if record.get("units") and displayed != linked:
        issues.append("source_army_does_not_match_link")
    # Even legacy links without hero encoding must have currently valid named loadouts.
    for loadout in record.get("hero_loadouts", []):
        for item in [loadout["hero"], loadout.get("pet"), *loadout.get("equipment", [])]:
            if item is None:
                continue
            match = by_name.get(normalized(item["name"]))
            if not match:
                unknown.append(f"unknown_loadout:{item['name']}")
            elif match[1]["min_hall"] > int(hall):
                issues.append(f"loadout_not_unlocked:{item['name']}")
            elif match[1].get("hero") and match[1]["hero"] != loadout["hero"]["name"]:
                issues.append(f"source_equipment_hero_mismatch:{item['name']}")
    source_heroes = {normalized(u["name"]) for u in record.get("units", []) if u["group"] == "hero"}
    source_heroes.update(normalized(h["hero"]["name"]) for h in record.get("hero_loadouts", []))
    if len(source_heroes) > RULES["capacity"][hall]["hero"]:
        issues.append("source_hero_slots_exceeded")
    encoded_heroes = {normalized(RULES["units"][h]["name"]) for h in heroes if h in RULES["units"]}
    if heroes and source_heroes and source_heroes != encoded_heroes:
        issues.append("source_heroes_do_not_match_link")
    if unknown:
        return result("unknown", *sorted(set(unknown + issues)))
    return result("incompatible" if issues else "compatible", *sorted(set(issues)))


def checked(record: dict, evidence: dict | None = None) -> dict:
    return {**record, "compatibility": assess(record, evidence)}
