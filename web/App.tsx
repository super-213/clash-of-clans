import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownUp,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ExternalLink,
  Heart,
  Layers3,
  Search,
  Shield,
  Swords,
  X,
  Castle,
  Radio,
  RefreshCw,
} from 'lucide-react';
import type { Catalog, Entry } from '../shared/schema';
import { date, purposes } from './format';
import { Dialog } from './components/Media';
import { EntryCard } from './components/EntryCard';
import { EntryDetail } from './components/EntryDetail';
import { SavedEntryStore, selectSavedEntries } from './saved-entries';

async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(`请求失败 (${response.status})`);
  return response.json();
}
function readSaved(): string[] {
  try {
    return JSON.parse(localStorage.getItem('atlas:saved') || '[]')
      .filter((x: unknown) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x))
      .slice(0, 200);
  } catch {
    return [];
  }
}
type Source = {
  id: string;
  name: string;
  home_url: string;
  enabled: number;
  status: string | null;
  finished_at: string | null;
  entries: number;
};

export function App() {
  const initial = new URLSearchParams(location.search);
  const [kind, setKind] = useState<'base' | 'army'>(
    initial.get('kind') === 'army' ? 'army' : 'base',
  );
  const [hall, setHall] = useState<number | null>(
    /^\d+$/.test(initial.get('th') || '')
      ? Number(initial.get('th'))
      : initial.has('kind')
        ? null
        : 18,
  );
  const [purpose, setPurpose] = useState(initial.get('purpose') || 'all');
  const [search, setSearch] = useState(initial.get('q') || '');
  const [query, setQuery] = useState(search);
  const [sort, setSort] = useState('latest');
  const [page, setPage] = useState(1);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [listItems, setItems] = useState<Entry[]>([]);
  const [listTotal, setTotal] = useState(0);
  const [listLoading, setLoading] = useState(true);
  const [listError, setError] = useState('');
  const [savedStore] = useState(() => new SavedEntryStore());
  const [savedEntries, setSavedEntries] = useState<Entry[]>([]);
  const [savedLoading, setSavedLoading] = useState(false);
  const [savedError, setSavedError] = useState('');
  const [saved, setSaved] = useState<string[]>(readSaved);
  const [savedOnly, setSavedOnly] = useState(false);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [toast, setToast] = useState('');
  const resultsRef = useRef<HTMLDivElement>(null);
  const [showSources, setShowSources] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [sourceError, setSourceError] = useState('');
  const [reload, setReload] = useState(0);
  const pageSize = 12;
  const savedResult = useMemo(
    () =>
      selectSavedEntries(
        savedEntries.filter((entry) => saved.includes(entry.id)),
        { kind, hall, purpose, query, sort, page, pageSize },
      ),
    [savedEntries, saved, kind, hall, purpose, query, sort, page],
  );
  const items = savedOnly ? savedResult.items : listItems;
  const total = savedOnly ? savedResult.total : listTotal;
  const loading = savedOnly ? savedLoading : listLoading;
  const error = savedOnly ? savedError : listError;

  useEffect(() => {
    const controller = new AbortController();
    api<Catalog>('/api/catalog', controller.signal)
      .then(setCatalog)
      .catch(() => {});
    return () => controller.abort();
  }, [reload]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setPage(1);
    }, 280);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    const params = new URLSearchParams({ kind });
    if (hall) params.set('th', String(hall));
    if (purpose !== 'all') params.set('purpose', purpose);
    if (query) params.set('q', query);
    history.replaceState(null, '', '?' + params);
    if (savedOnly) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const load = async () => {
      params.set('page', String(page));
      params.set('limit', String(pageSize));
      params.set('sort', sort);
      return api<{ items: Entry[]; total: number }>(
        '/api/entries?' + params,
        controller.signal,
      );
    };
    load()
      .then((result) => {
        if (!controller.signal.aborted) {
          savedStore.remember(result.items);
          setItems(result.items);
          setTotal(result.total);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [kind, hall, purpose, query, sort, page, savedOnly, savedStore, reload]);

  // Fetch only when the collection itself changes. Filters, sort and page are
  // derived above from this snapshot, so even a long browsing session is local.
  useEffect(() => {
    if (!savedOnly) return;
    let cancelled = false;
    setSavedLoading(true);
    setSavedError('');
    savedStore
      .getMany(saved, reload)
      .then((entries) => {
        if (!cancelled) setSavedEntries(entries);
      })
      .catch((err) => {
        if (!cancelled) setSavedError(err.message);
      })
      .finally(() => {
        if (!cancelled) setSavedLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [savedOnly, saved, reload, savedStore]);

  useEffect(() => {
    if (!showSources) return;
    const controller = new AbortController();
    setSourceError('');
    api<{ items: Source[] }>('/api/sources', controller.signal)
      .then((result) => setSources(result.items))
      .catch((err) => {
        if (!controller.signal.aborted) setSourceError(err.message);
      });
    return () => controller.abort();
  }, [showSources]);

  function changeKind(next: 'base' | 'army') {
    setKind(next);
    setPurpose('all');
    setPage(1);
  }
  function changeHall(next: number | null) {
    setHall(next);
    setPage(1);
  }
  function toggleSaved(id: string) {
    const next = saved.includes(id)
      ? saved.filter((x) => x !== id)
      : [id, ...saved].slice(0, 200);
    setSaved(next);
    try {
      localStorage.setItem('atlas:saved', JSON.stringify(next));
      setToast(saved.includes(id) ? '已取消收藏' : '已收藏');
    } catch {
      setToast('浏览器无法保存收藏，请检查存储设置');
    }
  }
  function openCollection(onlySaved: boolean) {
    setSavedOnly(onlySaved);
    setPage(1);
    if (onlySaved) {
      setHall(null);
      setPurpose('all');
      setSearch('');
    }
  }
  function changePage(next: number) {
    setPage(next);
    resultsRef.current?.scrollIntoView({ block: 'start' });
    resultsRef.current?.focus({ preventScroll: true });
  }
  async function copy(entry: Entry) {
    if (!entry.game_link) return;
    try {
      await navigator.clipboard.writeText(entry.game_link);
      setToast('游戏链接已复制');
    } catch {
      setSelected(entry);
      setToast('无法自动复制，请展开“来源与收录记录”手动复制');
    }
  }
  const totalOfKind =
    kind === 'base' ? catalog?.total_bases : catalog?.total_armies;
  const title = kind === 'base' ? '阵型' : '配兵';
  const selectedCount = catalog?.levels.find((level) => level.level === hall);
  const levels =
    catalog?.levels ??
    Array.from({ length: 18 }, (_, i) => ({
      level: 18 - i,
      bases: 0,
      armies: 0,
    }));

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/" aria-label="阵研所首页">
          <span className="brand-mark">
            <Castle size={24} strokeWidth={1.8} />
          </span>
          <span>阵研所</span>
        </a>
        <nav className="kind-tabs" aria-label="内容类型">
          <button
            aria-pressed={kind === 'base'}
            className={kind === 'base' ? 'selected' : ''}
            onClick={() => changeKind('base')}
          >
            <Shield size={16} />
            阵型
          </button>
          <button
            aria-pressed={kind === 'army'}
            className={kind === 'army' ? 'selected' : ''}
            onClick={() => changeKind('army')}
          >
            <Swords size={16} />
            配兵
          </button>
        </nav>
        <label className="search-box">
          <Search size={17} />
          <input
            aria-label="搜索阵型或配兵"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={kind === 'base' ? '搜索阵型、标签' : '搜索配兵'}
          />
          {search && (
            <button
              className="icon-button"
              aria-label="清空搜索"
              onClick={() => setSearch('')}
            >
              <X size={16} />
            </button>
          )}
        </label>
        <div className="header-actions">
          <button
            className={`collection-shortcut ${savedOnly ? 'selected' : ''}`}
            aria-label={`我的收藏，${saved.length} 项`}
            aria-pressed={savedOnly}
            onClick={() => openCollection(!savedOnly)}
          >
            <Heart size={17} fill={savedOnly ? 'currentColor' : 'none'} />
            <span>收藏</span>
            <span className="count">{saved.length}</span>
          </button>
          <button
            className="icon-button source-button"
            aria-label="查看数据来源"
            title="数据来源"
            onClick={() => setShowSources(true)}
          >
            <Radio size={18} />
          </button>
        </div>
      </header>
      <aside className="sidebar" aria-label="大本营等级">
        <div className="sidebar-section">大本营</div>
        <button
          className={`hall-button hall-all ${hall === null ? 'selected' : ''}`}
          aria-pressed={hall === null}
          onClick={() => changeHall(null)}
        >
          <span>全部等级</span>
          <span className="hall-count">{totalOfKind ?? '—'}</span>
        </button>
        <nav className="hall-list" aria-label="等级筛选">
          {levels.map((level) => (
            <button
              key={level.level}
              className={`hall-button ${hall === level.level ? 'selected' : ''}`}
              aria-pressed={hall === level.level}
              onClick={() => changeHall(level.level)}
            >
              <span>TH {level.level}</span>
              <span className="hall-count">
                {kind === 'base' ? level.bases : level.armies}
              </span>
            </button>
          ))}
        </nav>
      </aside>
      <div className="workspace">
        <main>
          {!savedOnly && (
            <section className="level-banner" aria-label="当前大本营等级">
              <div className="banner-label">
                <span className="banner-icon" aria-hidden="true">
                  <Castle size={32} />
                </span>
                <div>
                  <h2>{hall ? `${hall} 级大本营` : '全部大本营等级'}</h2>
                  <p>
                    {hall
                      ? (selectedCount?.bases ?? '—')
                      : (catalog?.total_bases ?? '—')}{' '}
                    个阵型
                    {' · '}
                    {hall
                      ? (selectedCount?.armies ?? '—')
                      : (catalog?.total_armies ?? '—')}{' '}
                    套配兵
                  </p>
                </div>
              </div>
              <span className="banner-word" aria-hidden="true">
                {hall ? `TH${hall}` : 'ATLAS'}
              </span>
            </section>
          )}
          <div className="page-heading" ref={resultsRef} tabIndex={-1}>
            <div className="heading-title">
              <h1>{savedOnly ? '我的收藏' : title}</h1>
              <span className="results-meta" aria-live="polite">
                {loading
                  ? '加载中…'
                  : `${total} ${kind === 'base' ? '个阵型' : '套配兵'}`}
                {query && ` · “${query}”`}
              </span>
            </div>
            <label className="hall-select">
              <select
                aria-label="选择大本营等级"
                value={hall ?? 'all'}
                onChange={(e) =>
                  changeHall(
                    e.target.value === 'all' ? null : Number(e.target.value),
                  )
                }
              >
                <option value="all">全部等级</option>
                {levels.map((level) => (
                  <option key={level.level} value={level.level}>
                    TH {level.level}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} />
            </label>
          </div>
          <div className="filter-row">
            <div className="purpose-filters" aria-label="用途筛选">
              {Object.entries(purposes)
                .filter(
                  ([key]) => kind === 'base' || ['all', 'war'].includes(key),
                )
                .map(([key, label]) => (
                  <button
                    key={key}
                    className={purpose === key ? 'selected' : ''}
                    aria-pressed={purpose === key}
                    onClick={() => {
                      setPurpose(key);
                      setPage(1);
                    }}
                  >
                    {key === 'all' ? '全部' : label}
                  </button>
                ))}
            </div>
            <label className="sort-select">
              <ArrowDownUp size={14} />
              <select
                aria-label="排序"
                value={sort}
                onChange={(e) => {
                  setSort(e.target.value);
                  setPage(1);
                }}
              >
                <option value="latest">最近收录</option>
                <option value="oldest">最早收录</option>
              </select>
              <ChevronDown size={13} />
            </label>
          </div>

          {error ? (
            <div className="empty">
              <RefreshCw size={28} />
              <h3>资料暂时加载失败</h3>
              <p>请稍后重试。</p>
              <button
                className="primary-button"
                onClick={() => setReload((x) => x + 1)}
              >
                重新加载
              </button>
            </div>
          ) : loading ? (
            <div className="entry-grid">
              {Array.from({ length: 6 }, (_, i) => (
                <div className="skeleton" key={i}>
                  <div />
                  <span />
                  <span />
                </div>
              ))}
            </div>
          ) : items.length ? (
            <div className="entry-grid">
              {items.map((entry) => (
                <EntryCard
                  key={entry.id}
                  entry={entry}
                  isSaved={saved.includes(entry.id)}
                  onSave={toggleSaved}
                  onSelect={setSelected}
                  onCopy={copy}
                />
              ))}
            </div>
          ) : (
            <div className="empty">
              <Layers3 size={34} />
              <h3>{savedOnly ? '这里还没有收藏' : '暂时没有匹配的资料'}</h3>
              <p>
                {savedOnly
                  ? '收藏的阵型和配兵会显示在这里，仅保存在当前浏览器。'
                  : '试试其他等级，或清除筛选。'}
              </p>
              <button
                className="secondary-button"
                onClick={() => {
                  changeHall(null);
                  setSearch('');
                  setPurpose('all');
                  if (savedOnly) setSavedOnly(false);
                }}
              >
                查看全部资料
                <ArrowRight size={14} />
              </button>
            </div>
          )}

          {total > pageSize && !loading && !error && (
            <nav className="pagination" aria-label="分页">
              <span>
                第 {page} / {Math.ceil(total / pageSize)} 页
              </span>
              <button
                disabled={page === 1}
                aria-label="上一页"
                onClick={() => changePage(page - 1)}
              >
                <ArrowLeft size={16} />
              </button>
              <button
                disabled={page * pageSize >= total}
                aria-label="下一页"
                onClick={() => changePage(page + 1)}
              >
                <ArrowRight size={16} />
              </button>
            </nav>
          )}
          <footer>
            <span>非官方玩家资料库 · 未经 Supercell 认可</span>
            <button
              className="footer-source"
              onClick={() => setShowSources(true)}
            >
              数据来源
            </button>
            <a
              href="https://supercell.com/en/fan-content-policy/"
              target="_blank"
              rel="noopener noreferrer"
            >
              粉丝内容政策 <ExternalLink size={12} />
            </a>
          </footer>
        </main>
      </div>

      {selected && (
        <EntryDetail
          selected={selected}
          isSaved={saved.includes(selected.id)}
          onSave={toggleSaved}
          onCopy={copy}
          onClose={() => setSelected(null)}
        />
      )}
      {showSources && (
        <Dialog close={() => setShowSources(false)} label="数据来源">
          <div className="sources-body">
            <h2>数据来源</h2>
            <p>
              最近采集 {date(catalog?.last_sync ?? null)}
              。各条内容的原始页面和收录记录可在详情查看。
            </p>
            {sourceError ? (
              <p role="alert">{sourceError}</p>
            ) : sources.length ? (
              sources.map((source) => (
                <div className="source-row" key={source.id}>
                  <div>
                    <a
                      href={source.home_url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {source.name}
                      <ExternalLink size={13} />
                    </a>
                    <small>
                      收录 {source.entries} 条资料 · 最近运行{' '}
                      {date(source.finished_at)}
                    </small>
                  </div>
                  <span
                    className={`source-state ${source.status === 'success' ? 'ok' : ''}`}
                  >
                    {!source.enabled
                      ? '已停用'
                      : source.status === 'success'
                        ? '采集成功'
                        : source.status === 'partial'
                          ? '部分失败'
                          : source.status === 'failed'
                            ? '采集失败'
                            : '尚无运行记录'}
                  </span>
                </div>
              ))
            ) : (
              <p>暂无来源记录。</p>
            )}
            <div className="sources-note">
              <Shield size={18} />
              <p>
                图片不可用时可到原始页面查看；采集成功不代表链接已在游戏内验证。
              </p>
            </div>
          </div>
        </Dialog>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
    </div>
  );
}
