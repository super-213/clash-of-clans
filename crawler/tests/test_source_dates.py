from copy import deepcopy
import json
from bs4 import BeautifulSoup

from atlas.source_dates import normalize_date, source_dates, backfill_cached_dates
from atlas.adapters import parse_armies, parse_layout, parse_blueprint
from atlas.base_sources import parse_clashcodes, parse_clashbaselink
from atlas.compatibility import assess
from test_adapters import SOURCE, ARMY_HTML, BASE_HTML, BLUEPRINT_HTML
from test_compatibility import army


def soup(html):
    return BeautifulSoup(html, 'html.parser')


def test_normalize_timezone_precision_and_missing_dates_without_guessing():
    assert normalize_date('2026-07-28 10:01:57 +0100') == '2026-07-28T09:01:57.000Z'
    assert normalize_date('2026-07-21 00:56:57') == '2026-07-21'
    assert normalize_date('2026-07-28') == '2026-07-28'
    for value in (None, '', 'yesterday', '2026-02-30', '2026-07-28T99:00:00Z'):
        assert normalize_date(value) is None


def test_page_meta_and_matching_jsonld_ignore_related_articles_and_generic_times():
    html = '''<meta property="article:published_time" content="2026-07-21 00:56:57">
    <aside><time datetime="2026-10-14">Today</time></aside>
    <script type="application/ld+json">{"@graph":[
      {"@type":"Article","url":"https://example.com/other","dateModified":"2026-10-14"},
      {"@type":"Article","url":"https://example.com/main","dateModified":"2026-08-01T02:00:00+02:00"}
    ]}</script>'''
    assert source_dates(soup(html), 'https://example.com/main') == {
        'source_published_at': '2026-07-21', 'source_updated_at': '2026-08-01T00:00:00.000Z'}
    assert source_dates(soup('<time datetime="2026-10-14">Today</time>'), 'https://example.com/main') == {
        'source_published_at': None, 'source_updated_at': None}


def test_date_created_is_not_substituted_for_publication_and_malformed_schema_is_ignored():
    html = '''<script type="application/ld+json">invalid</script>
    <script type="application/ld+json">{"@type":"Article","url":"https://example.com/main","dateCreated":"2026-08-01"}</script>'''
    assert source_dates(soup(html), 'https://example.com/main')['source_published_at'] is None


def test_duplicate_blueprint_schemas_prefer_explicit_timezone_and_match_current_page():
    nodes = [{'@type':'BlogPosting','url':'https://example.com/main','datePublished':'2026-07-28'},
             {'@type':'Article','url':'https://example.com/main','datePublished':'2026-07-28 10:01:57 +0100',
              'dateModified':'2026-07-29 03:24:46 +0100'}]
    html = ''.join(f'<script type="application/ld+json">{json.dumps(n)}</script>' for n in nodes)
    assert source_dates(soup(html), 'https://example.com/main')['source_published_at'] == '2026-07-28T09:01:57.000Z'


def test_army_listing_dates_never_get_assigned_to_every_link():
    meta = '<meta property="article:modified_time" content="2026-10-14T00:00:00Z">'
    assert parse_armies(meta + ARMY_HTML, 'https://source.example/list', SOURCE, 18)[0]['source_updated_at'] is None
    html = ARMY_HTML.replace('<h3>', '<time itemprop="datePublished" datetime="2026-08-01"></time><h3>')
    assert parse_armies(html, 'https://source.example/list', SOURCE, 18)[0]['source_published_at'] == '2026-08-01'


def test_all_page_adapters_attach_source_article_dates():
    meta = '<meta property="article:published_time" content="2026-08-01T00:00:00Z">'
    assert parse_layout(meta + BASE_HTML, 'https://source.example/layout', SOURCE, 18)['source_published_at'] == '2026-08-01T00:00:00.000Z'
    assert parse_blueprint(meta + BLUEPRINT_HTML, 'https://source.example/guide', SOURCE, 18)['source_published_at'] == '2026-08-01T00:00:00.000Z'
    codes = '<a href="https://link.clashofclans.com/en?action=OpenLayout&amp;id=TH18:WB:one"><img class="coc-base-map" src="/one.jpg"></a>'
    assert parse_clashcodes(meta + codes, 'https://source.example/collection', SOURCE, 18)[0]['source_published_at'] == '2026-08-01T00:00:00.000Z'
    bases = '<article><div class="gh-content"><figure class="kg-image-card"><img src="/one.jpg"></figure><a class="kg-btn" href="https://link.clashofclans.com/en?action=OpenLayout&amp;id=TH18:WB:one">Copy</a></div></article>'
    assert parse_clashbaselink(meta + bases, 'https://source.example/collection', SOURCE, 18)[0]['source_published_at'] == '2026-08-01T00:00:00.000Z'


def test_dates_do_not_change_compatibility_in_either_direction():
    for record in (army('u1x0'), army('u361x0')):
        expected = assess(record)
        for timestamp in ('2001-01-01', '2099-01-01', None):
            changed = deepcopy(record)
            changed.update(source_published_at=timestamp, source_updated_at=timestamp,
                           first_seen_at='2026-10-14T00:00:00Z')
            assert assess(changed) == expected


def test_cached_backfill_does_not_invent_dates_or_apply_listing_dates_to_armies(tmp_path):
    import sqlite3
    cache = tmp_path / 'cache.sqlite'
    with sqlite3.connect(cache) as db:
        db.execute('CREATE TABLE responses(url TEXT,body BLOB,mime TEXT)')
        db.execute('INSERT INTO responses VALUES(?,?,?)', ('https://source.example/article',
            b'<meta property="article:published_time" content="2026-08-01">', 'text/html'))
        db.execute('INSERT INTO responses VALUES(?,?,?)', ('https://source.example/coc/army/th18',
            ('<meta property="article:published_time" content="2026-10-14">' + ARMY_HTML).encode(), 'text/html'))
    record = army('u1x0')
    article = {**record, 'source_url':'https://source.example/article', 'first_seen_at':'2026-09-01T00:00:00Z'}
    strategy = {**record, 'source_url':'https://source.example/coc/army/th18/hydra'}
    sources = [{'id':record['source_id'], 'adapter':'clashest', 'base_url':'https://source.example'}]
    a, b = backfill_cached_dates([article, strategy], str(cache), sources)
    assert a['source_published_at'] == '2026-08-01'
    assert a['first_seen_at'] == article['first_seen_at']
    assert b['source_published_at'] is None
    existing = {**article, 'source_published_at':'2026-09-01'}
    assert backfill_cached_dates([existing], str(cache), sources)[0]['source_published_at'] == '2026-09-01'
