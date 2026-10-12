import pytest

from atlas.adapters import discover_layouts, parse_layout, parse_armies, parse_blueprint
from atlas.http import CrawlError
from atlas.models import fingerprint

SOURCE = {"id": "test", "name": "Test"}
BASE_HTML = '''<h1>Anti 3 Stars War Base</h1><a class="base_link_button" href="https://link.clashofclans.com/en?action=OpenLayout&amp;id=TH18%3AWB%3Asample">Copy</a><img src="/pics/th18_plans/war/thumb/th18_war_1.jpg">'''
ARMY_HTML = '''<article id="hydra"><h3><a href="/coc/army/th18/hydra">Hydra</a></h3>
<div title="9× Dragon Rider"><img alt="Dragon Rider" src="/game/coc/levels/dragon-rider/entry.webp"></div>
<span><img alt="Rage Spell" src="/game/coc/levels/rage-spell/entry.webp"><span>2<!-- -->×</span> Rage Spell</span>
<div title="Siege: Battle Blimp"><img alt="Battle Blimp" src="/game/coc/levels/battle-blimp/entry.webp"></div>
<li><span><img alt="Archer Queen" src="/game/coc/heroes/archer-queen.webp"></span>Queen</li>
<a href="https://link.clashofclans.com/en?action=CopyArmy&amp;army=u9x65s2x2">Copy</a></article>'''


def test_layouts_and_normalization():
    url = "https://source.example/plans/th_18/war_1.html"
    record = parse_layout(BASE_HTML, url, SOURCE, 18)
    assert record["tags"] == ["防三星"]
    assert record["image_url"] == "https://source.example/pics/th18_plans/war/thumb/th18_war_1.jpg"
    alternate = {**record, "game_link": "https://link.clashofclans.com/cn?id=TH18:WB:sample&action=OpenLayout&utm_source=x"}
    assert fingerprint(record) == fingerprint(alternate)
    with pytest.raises(ValueError, match="Hall"):
        parse_layout(BASE_HTML, url, SOURCE, 17)
    with pytest.raises(CrawlError):
        parse_layout("<h1>Page changed</h1>", url, SOURCE, 18)


def test_listing_only_follows_layout_images():
    html = '<a href="/other">Other</a><a href="/plans/th_18/war_1.html"><img class="base_grid_img"></a>'
    assert discover_layouts(html, "https://source.example") == ["https://source.example/plans/th_18/war_1.html"]


def test_army_counts_images_and_scope():
    records = parse_armies(ARMY_HTML, "https://source.example/coc/army/th18", SOURCE, 18)
    assert len(records) == 1
    assert [(u["group"], u["count"]) for u in records[0]["units"]] == [("troop", 9), ("spell", 2), ("siege", 1), ("hero", 1)]
    assert records[0]["source_url"].endswith('/th18/hydra')
    assert fingerprint(records[0]) != fingerprint({**records[0], "town_hall": 17})
    with pytest.raises(CrawlError):
        parse_armies("<article>No links</article>", "https://source.example", SOURCE, 18)
    with pytest.raises(CrawlError, match="Spell count"):
        parse_armies(ARMY_HTML.replace('2<!-- -->×', '?'), "https://source.example", SOURCE, 18)


def test_explicitly_unavailable_layout_retains_image_without_faking_link():
    html = '<h1>TH3 War Base</h1><img src="/thumb/base.jpg"><p>Base link for this layout is temporarily unavailable</p>'
    record = parse_layout(html, 'https://source.example/war_3.html', SOURCE, 3)
    assert record['game_link'] is None
    assert fingerprint(record)


def test_hero_equipment_associations_and_unknown_pets():
    html = ARMY_HTML.replace('Queen</li>', 'Archer Queen — Healer Puppet + Invisibility Vial (opening charge)</li>')
    html = html.replace('</article>', '<li><img alt="Barbarian King" src="/game/coc/heroes/barbarian-king.webp">Barbarian King — funnel/cleanup</li></article>')
    loadouts = parse_armies(html, 'https://source.example/coc/army/th18', SOURCE, 18)[0]['hero_loadouts']
    assert [e['name'] for e in loadouts[0]['equipment']] == ['Healer Puppet', 'Invisibility Vial']
    assert loadouts[0]['hero']['name'] == 'Archer Queen'
    assert loadouts[0]['pet'] is None
    assert loadouts[0]['notes'] == 'opening charge'
    assert loadouts[1]['equipment'] == []
    assert loadouts[1]['notes'] == 'funnel/cleanup'
    assert loadouts[0]['source_url'].endswith('/th18/hydra')
    # New equipment names remain visible before an illustration is added to the registry.
    newer = html.replace('Healer Puppet', 'Future Equipment')
    assert parse_armies(newer, 'https://source.example', SOURCE, 18)[0]['hero_loadouts'][0]['equipment'][0]['image_url'] is None


BLUEPRINT_HTML = '''<h1>TH18 Hydra</h1><article>
<h2>TH18 Hydra Army Composition + Copy Link</h2>
<p><img alt="TH18 Hydra Army Comp" src="https://source.example/army.jpg"></p>
<a href="https://link.clashofclans.com/en/?action=CopyArmy&amp;army=h7p11e53_57u8x8s2x5">Copy</a>
<p>Heroes: Dragon Duke (Rocket Backpack + Flame Blower), Grand Warden (Eternal Tome + Healing Tome).</p>
<h2>How to Execute</h2><ol><li>Start the Dragon Duke on one corner — with Angry Jelly, he targets defenses.</li><li>Deploy Grand Warden in the middle.</li></ol>
<h2>Other strategy</h2><p>Heroes: Archer Queen (Giant Arrow + Action Figure).</p>
</article>'''


def test_blueprint_scoped_loadouts_and_explicit_pet_only():
    record = parse_blueprint(BLUEPRINT_HTML, 'https://source.example/hydra', SOURCE, 18)
    a, b = record['hero_loadouts']
    assert a['hero']['name'] == 'Dragon Duke'
    assert a['pet']['name'] == 'Angry Jelly'
    assert [e['name'] for e in a['equipment']] == ['Rocket Backpack', 'Flame Blower']
    assert b['hero']['name'] == 'Grand Warden'
    assert b['pet'] is None
    assert record['game_link'].endswith('army=h7p11e53_57u8x8s2x5')
    assert record['units'] == []  # Article supplies an image, not a full count table.
    without = parse_blueprint(BLUEPRINT_HTML.replace('with Angry Jelly,', 'without a pet,'), 'https://source.example/hydra', SOURCE, 18)
    assert all(h['pet'] is None for h in without['hero_loadouts'])
    with pytest.raises(CrawlError):
        parse_blueprint(BLUEPRINT_HTML.replace('Heroes:', 'Changed:'), 'https://source.example', SOURCE, 18)
