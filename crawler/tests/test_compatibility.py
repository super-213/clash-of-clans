from copy import deepcopy
import json

import pytest

from atlas.compatibility import RULES, assess, checked, load_evidence
from atlas.models import fingerprint, make_record
from atlas.discovery import walk_pages


def base(hall=18):
    return make_record({"id": "test", "name": "Test"}, kind="base", town_hall=hall,
                       title="Latest 2026", purpose="war", units=[],
                       game_link=f"https://link.clashofclans.com/en?action=OpenLayout&id=TH{hall}:WB:opaque",
                       image_url="https://source.example/base.jpg", source_url="https://source.example/base")


def proof(record):
    return {fingerprint(record): {"layout_id": f"TH{record['town_hall']}:WB:opaque",
             "image_url": record["image_url"], "evidence_url": record["source_url"],
             "method": "game-export", "buildings": deepcopy(RULES["buildings"][str(record["town_hall"])])}}


def army(payload="u1x0", hall=18, units=None):
    return {**base(hall), "kind": "army", "units": units or [],
            "game_link": "https://link.clashofclans.com/en?action=CopyArmy&army=" + payload}


@pytest.mark.parametrize("hall", range(3, 19))
def test_complete_inventory_uses_its_own_hall(hall):
    record = base(hall)
    assert assess(record, proof(record))["status"] == "compatible"


def test_opaque_links_and_latest_titles_never_prove_building_completeness():
    assert assess(base())["status"] == "unknown"
    assert assess({**base(), "game_link": None})["status"] == "unknown"


@pytest.mark.parametrize("hall,missing", [(4, "Hero Hall"), (8, "Blacksmith"),
    (9, "Helper Hut"), (15, "Monolith"), (17, "Firespitter"), (18, "Revenge Tower")])
def test_missing_new_building_rejects_old_structure(hall, missing):
    record = base(hall)
    evidence = proof(record)
    del evidence[fingerprint(record)]["buildings"][missing]
    result = assess(record, evidence)
    assert result["status"] == "incompatible"
    assert any(missing in r for r in result["reasons"])


def test_removed_merged_buildings_counts_and_optional_builders():
    record = base(17)
    evidence = proof(record)
    buildings = evidence[fingerprint(record)]["buildings"]
    buildings["Builder's Hut"] = 2
    assert assess(record, evidence)["status"] == "compatible"
    buildings["Eagle Artillery"] = 1
    assert assess(record, evidence)["status"] == "incompatible"
    del buildings["Eagle Artillery"]
    buildings["Barracks"] = 4
    assert assess(record, evidence)["status"] == "incompatible"


def test_building_evidence_cannot_be_reused_for_a_different_link_image_or_rules(tmp_path):
    record = base()
    evidence = proof(record)
    assert assess({**record, "image_url": "https://source.example/changed.jpg"}, evidence)["status"] == "unknown"
    changed = {**record, "game_link": record["game_link"] + "other"}
    assert assess(changed, evidence)["status"] == "unknown"
    path = tmp_path / "evidence.json"
    path.write_text(json.dumps({"rules_version": "old", "layouts": evidence}))
    assert load_evidence(path) == {}


def test_old_army_with_current_units_remains_valid_without_any_new_units():
    result = assess(army("u10x0s1x0", hall=8))
    assert result["status"] == "compatible" and not result["reasons"]


@pytest.mark.parametrize("payload,hall,reason", [
    ("u1x65", 12, "unit_not_unlocked"),
    ("u1x109", 15, "unit_not_unlocked"),
    ("u1x26", 10, "unit_not_unlocked"),
    ("u361x0", 18, "capacity_exceeded:troop"),
    ("u1x0s12x0", 18, "capacity_exceeded:spell"),
    ("u1x0-1x0", 18, "duplicate_unit"),
    ("u0x0", 18, "invalid_unit_count"),
    ("h7u1x0", 14, "unit_not_unlocked"),
    ("h1e0u1x0", 18, "equipment_hero_mismatch"),
])
def test_invalid_armies_are_filtered_with_specific_reasons(payload, hall, reason):
    result = assess(army(payload, hall))
    assert result["status"] == "incompatible"
    assert any(reason in r for r in result["reasons"])


@pytest.mark.parametrize("payload", ["u1x999999", "u1x47", "u1x0garbage", "u1x0s", "u1x0u1x1"])
def test_unknown_event_or_unsupported_encoding_is_quarantined_without_guessing(payload):
    assert assess(army(payload))["status"] == "unknown"


def test_source_composition_must_match_actual_share_payload():
    units = [{"name": "Dragon", "count": 1, "group": "troop", "image_url": "https://source.example/d.jpg"}]
    assert assess(army("u1x8", units=units))["status"] == "compatible"
    assert "source_army_does_not_match_link" in assess(army("u1x0", units=units))["reasons"]


def test_current_hero_pet_equipment_and_reinforcement_encoding():
    assert assess(army("h7p11e53_57u8x8s2x5"))["status"] == "compatible"
    assert assess(army("h2m1p16e4_34u1x0"))["status"] == "compatible"
    assert assess(army("i1x188d1x98u8x8s2x5"))["status"] == "unknown"


def test_source_heroes_obey_current_slots_and_encoded_selection():
    source_heroes = [{"name": name, "group": "hero", "count": 1,
                      "image_url": "https://source.example/hero.webp"}
                     for name in ('Barbarian King', 'Archer Queen')]
    assert 'source_hero_slots_exceeded' in assess(army('u1x0', hall=8, units=source_heroes))['reasons']
    assert 'source_heroes_do_not_match_link' in assess(army('h7u1x0', units=source_heroes))['reasons']
    assert 'duplicate_equipment:Barbarian Puppet' in assess(army('h0e0_0u1x0'))['reasons']


def test_quarantined_article_does_not_retry_forever_or_drop_valid_sibling():
    rows, cursor = walk_pages(lambda u: u, "listing", lambda h,u: (["article"], None),
        lambda h,u: [army("u1x0"), army("u361x0"), base()], None, None,
        pytest.fail, transform=checked)
    assert [r["compatibility"]["status"] for r in rows] == ["compatible", "incompatible", "unknown"]
    assert cursor["complete"]


def test_current_inventory_accounts_for_merges_and_earlier_hall_changes():
    assert RULES['buildings']['16']['Cannon'] == 3
    assert RULES['buildings']['16']['Archer Tower'] == 4
    assert 'Eagle Artillery' not in RULES['buildings']['17']
    assert RULES['buildings']['17']['Multi-Gear Tower'] == 1
    assert RULES['buildings']['18']['Wizard Tower'] == 2
    assert RULES['buildings']['18']['Super Wizard Tower'] == 2
    assert RULES['buildings']['4']['Hero Hall'] == 1
    assert RULES['buildings']['11']['Crafting Station'] == 1


def test_current_crafted_defense_replaces_station_rather_than_adding_a_building():
    record = base(11)
    evidence = proof(record)
    buildings = evidence[fingerprint(record)]['buildings']
    del buildings['Crafting Station']
    buildings['Hot Candle'] = 1
    assert assess(record, evidence)['status'] == 'compatible'
    buildings['Hero Hunter'] = 1
    assert assess(record, evidence)['status'] == 'incompatible'


def test_legacy_database_rows_are_quarantined_without_deleting_provenance():
    import sqlite3
    from pathlib import Path
    migrations = Path(__file__).resolve().parents[2] / 'migrations'
    db = sqlite3.connect(':memory:')
    db.executescript((migrations / '0001_initial.sql').read_text())
    db.executescript((migrations / '0002_hero_loadouts.sql').read_text())
    db.executescript("""
        INSERT INTO sources VALUES('test','Test','https://example.com',1);
        INSERT INTO entries(id,kind,village,town_hall,title,purpose,image_url,
          source_id,source_url,source_name,content_hash,created_at,updated_at,last_seen_at,link_status)
        VALUES('entry','base','home',18,'Base','war','https://example.com/base.jpg',
          'test','https://example.com','Test','hash','old','old','old','confirmed');
        INSERT INTO provenance VALUES('entry','test','https://example.com','old','old');
    """)
    db.executescript((migrations / '0003_compatibility.sql').read_text())
    row = db.execute('SELECT compatibility,link_status FROM entries').fetchone()
    assert json.loads(row[0])['status'] == 'unknown'
    assert row[1] == 'confirmed'
    assert db.execute('SELECT COUNT(*) FROM provenance').fetchone()[0] == 1
    db.close()
