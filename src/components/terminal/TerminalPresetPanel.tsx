import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ChevronDown, ChevronUp, Plus, Save, Star, Trash2, TrendingDown, TrendingUp, X } from 'lucide-react';
import type { MarketCoin, TerminalChartBlock, TerminalSavedPreset, Timeframe } from '../../types';
import type { MarketCoinSnapshot, MarketSelection } from '../../utils/marketCoinLoader';
import { MARKET_PRESETS, coinMarketKey, selectMarketPresetCoins, type TerminalMarketPreset } from '../../utils/marketPresets';

interface Props {
  blocks: TerminalChartBlock[];
  watchlist: string[];
  presets: TerminalSavedPreset[];
  selection: MarketSelection;
  timeframe: Timeframe;
  activePreset: TerminalMarketPreset | null;
  autoUpdate: boolean;
  snapshot: MarketCoinSnapshot;
  loading: boolean;
  error: string | null;
  onActivePresetChange: (preset: TerminalMarketPreset | null) => void;
  onPresetChosen?: () => void;
  onApplyCoins: (coins: MarketCoin[]) => void;
  onSavePreset: (name: string, blocks: TerminalChartBlock[]) => void;
  onLoadPreset: (preset: TerminalSavedPreset) => void;
  onDeletePreset: (id: string) => void;
  syncError: boolean;
  onRetrySync: () => void;
  signedIn: boolean;
}

const ICONS = { active: Activity, top_gainers: TrendingUp, top_losers: TrendingDown, near_highs: ChevronUp, near_lows: ChevronDown };
const controlClass = 'rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-cyan-500';

export function TerminalPresetPanel({ blocks, watchlist, presets, selection, timeframe, activePreset, autoUpdate, snapshot, loading, error,
  onActivePresetChange, onPresetChosen, onApplyCoins, onSavePreset, onLoadPreset, onDeletePreset, syncError, onRetrySync, signedIn }: Props) {
  const { exchange, marketType } = selection;
  const [showPresets, setShowPresets] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [source, setSource] = useState<'favorites' | 'workspace'>('favorites');
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const applyRef = useRef(onApplyCoins);
  applyRef.current = onApplyCoins;

  const readyCoins = useMemo(() => Object.fromEntries(MARKET_PRESETS.map(preset =>
    [preset.id, selectMarketPresetCoins(snapshot.coins, preset.id, selection, Number.POSITIVE_INFINITY)])) as Record<TerminalMarketPreset, MarketCoin[]>,
  [snapshot.coins, selection]);

  useEffect(() => {
    if (activePreset && autoUpdate && !error && readyCoins[activePreset].length) {
      applyRef.current(readyCoins[activePreset]);
    }
  }, [activePreset, autoUpdate, readyCoins, error]);

  const chooseReadyPreset = (id: TerminalMarketPreset) => {
    if (error || !readyCoins[id].length) {
      setMessage(error || 'За цими фільтрами немає монет. Змініть біржу або ринок.');
      return;
    }
    setMessage(null);
    onActivePresetChange(id);
    onApplyCoins(readyCoins[id]);
    onPresetChosen?.();
  };

  // Favorites store symbols; select one explicit exchange/market for each symbol.
  // Index once per quote refresh instead of scanning the full exchange universe
  // for every favorite (some users have hundreds of saved instruments).
  const favoritesQuotesBySymbol = useMemo(() => {
    const index = new Map<string, MarketCoin[]>();
    for (const coin of snapshot.coins) {
      const group = index.get(coin.symbol);
      if (group) group.push(coin);
      else index.set(coin.symbol, [coin]);
    }
    return index;
  }, [snapshot.coins]);
  const workspaceBlocksByMarket = useMemo(() =>
    new Map(blocks.map(block => [coinMarketKey(block), block] as const)), [blocks]);
  const favoriteBlocks = useMemo(() => [...new Set(watchlist)].flatMap(symbol => {
    const preferredExchange = exchange === 'all' ? 'binance' : exchange;
    const preferredMarket = marketType === 'all' ? 'futures' : marketType;
    const matches = (favoritesQuotesBySymbol.get(symbol) || []).filter(coin =>
      (exchange === 'all' || coin.exchange === exchange)
      && (marketType === 'all' || coin.marketType === marketType));
    const coin = matches.find(coin => coin.exchange === preferredExchange && coin.marketType === preferredMarket) || matches[0];
    const existing = workspaceBlocksByMarket.get(coinMarketKey({
      symbol, exchange: preferredExchange, marketType: preferredMarket,
    }));
    const item = coin || existing;
    return item ? [{ id: `favorite-${coinMarketKey(item)}`, symbol: item.symbol, baseAsset: item.baseAsset, quoteAsset: item.quoteAsset,
      exchange: item.exchange, marketType: item.marketType, timeframe, colSpan: 1 as const }] : [];
  }), [watchlist, favoritesQuotesBySymbol, exchange, marketType, workspaceBlocksByMarket, timeframe]);
  const candidates = source === 'favorites' ? favoriteBlocks : blocks;
  const selectedBlocks = candidates.filter(block => selectedKeys.includes(block.id));

  const openForm = useCallback((nextSource: 'favorites' | 'workspace') => {
    // Opening a draft is not a workspace change. Do not disable a running
    // market preset just because the user wants to save their current view.
    setSource(nextSource);
    setSelectedKeys((nextSource === 'favorites' ? favoriteBlocks : blocks).slice(0, 50).map(block => block.id));
    setName('');
    setFormError(null);
    setShowForm(true);
    setShowPresets(true);
  }, [favoriteBlocks, blocks]);

  const savePreset = (event: React.FormEvent) => {
    event.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) { setFormError('Введіть назву пресету.'); return; }
    if (presets.some(preset => preset.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase())) {
      setFormError('Пресет з такою назвою вже є. Виберіть іншу назву.'); return;
    }
    if (!selectedBlocks.length) { setFormError('Виберіть хоча б одну монету.'); return; }
    if (selectedBlocks.length > 50) { setFormError('У пресеті може бути до 50 графіків.'); return; }
    if (presets.length >= 30) { setFormError('Можна зберегти до 30 пресетів. Видаліть зайвий пресет.'); return; }
    onSavePreset(cleanName, selectedBlocks);
    setShowForm(false);
    setMessage(`Пресет «${cleanName}» збережено (${selectedBlocks.length} монет).`);
  };

  return <section aria-label="Пресети монет термінала" className="bg-slate-950/90 p-2 text-xs">
    <div className="grid grid-cols-2 gap-1.5">
        {MARKET_PRESETS.map(preset => {
          const Icon = ICONS[preset.id];
          return <button key={preset.id} type="button" title={preset.description} aria-pressed={activePreset === preset.id}
            disabled={loading && !snapshot.coins.length} onClick={() => chooseReadyPreset(preset.id)}
            className={`flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] font-semibold transition-colors disabled:opacity-40 ${activePreset === preset.id
              ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-300' : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-cyan-500/50 hover:text-white'}`}>
            <Icon className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{preset.label}</span>
          </button>;
        })}
        <button type="button" aria-expanded={showPresets} onClick={() => setShowPresets(value => !value)}
          className="flex min-w-0 items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300">
          <Star className="h-3.5 w-3.5 shrink-0" /><span className="min-w-0 truncate">Мої пресети{presets.length > 0 && ` (${presets.length})`}</span>
          {showPresets ? <ChevronUp className="ml-auto h-3 w-3 shrink-0" /> : <ChevronDown className="ml-auto h-3 w-3 shrink-0" />}
        </button>
    </div>
    {(error || snapshot.warning) && <p role="status" className="mt-2 text-amber-300">{error || snapshot.warning}</p>}
    {message && <p role="status" className="mt-2 text-slate-300">{message}</p>}
    {showPresets && <div className="mt-3 border-t border-slate-800 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => openForm('favorites')} className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-2 font-semibold text-white hover:bg-cyan-500">
          <Plus className="h-3.5 w-3.5" />Створити з обраних монет
        </button>
        <button type="button" onClick={() => openForm('workspace')} disabled={!blocks.length}
          className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-slate-300 hover:bg-slate-800 disabled:opacity-40">
          <Save className="h-3.5 w-3.5" />Зберегти монети термінала
        </button>
        {!signedIn && <span className="text-slate-500">Пресети зберігаються на цьому пристрої. Увійдіть для збереження у профілі.</span>}
      </div>
      {syncError && <p role="status" className="mt-2 text-amber-300">Не вдалося синхронізувати пресети. <button type="button" onClick={onRetrySync} className="underline hover:text-white">Повторити збереження</button></p>}
      {showForm && <form onSubmit={savePreset} className="mt-3 space-y-3 rounded-xl border border-slate-700 bg-slate-900/80 p-3">
        <div className="flex items-center gap-2">
          <label className="flex flex-1 items-center gap-2 text-slate-300">Назва
            <input aria-label="Назва пресету" value={name} onChange={event => setName(event.target.value)} maxLength={60}
              placeholder="Наприклад, Мої альткоїни" className={`${controlClass} w-full min-w-0 select-text`} />
          </label>
          <button type="button" aria-label="Закрити створення пресету" onClick={() => setShowForm(false)} className="p-1 text-slate-400 hover:text-white"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-slate-400">
          <span>Монети:</span>
          <button type="button" aria-pressed={source === 'favorites'} onClick={() => { setSource('favorites'); setSelectedKeys(favoriteBlocks.slice(0, 50).map(block => block.id)); }}
            className={`rounded-lg px-2 py-1 ${source === 'favorites' ? 'bg-amber-500/15 text-amber-300' : 'hover:bg-slate-800'}`}>Обрані монети</button>
          <button type="button" aria-pressed={source === 'workspace'} onClick={() => { setSource('workspace'); setSelectedKeys(blocks.slice(0, 50).map(block => block.id)); }}
            className={`rounded-lg px-2 py-1 ${source === 'workspace' ? 'bg-cyan-500/15 text-cyan-300' : 'hover:bg-slate-800'}`}>Поточні графіки</button>
          <button type="button" onClick={() => setSelectedKeys(candidates.slice(0, 50).map(block => block.id))} className="ml-auto hover:text-white">Вибрати всі</button>
          <button type="button" onClick={() => setSelectedKeys([])} className="hover:text-white">Зняти вибір</button>
        </div>
        {candidates.length ? <div className="grid max-h-40 grid-cols-1 gap-1 overflow-y-auto">
          {candidates.map(block => <label key={block.id} className="flex cursor-pointer items-center gap-2 rounded-lg bg-slate-950/70 px-2 py-2 text-slate-300">
            <input type="checkbox" aria-label={`Вибрати ${block.symbol} ${block.exchange} ${block.marketType}`} checked={selectedKeys.includes(block.id)}
              onChange={event => { const checked = event.target.checked; setSelectedKeys(current => checked ? [...current, block.id] : current.filter(id => id !== block.id)); }} className="accent-cyan-500" />
            <span><strong>{block.symbol}</strong><span className="ml-1 text-[10px] text-slate-500">{block.exchange === 'binance' ? 'Binance' : 'Bybit'} · {block.marketType} · {block.timeframe}</span></span>
          </label>)}
        </div> : <p className="text-slate-400">{source === 'favorites' ? 'Додайте монети до обраних у скрінері або виберіть поточні графіки. Для обраних монет мають бути доступні дані вибраної біржі та ринку.' : 'Додайте графіки до термінала.'}</p>}
        {formError && <p role="alert" className="text-rose-300">{formError}</p>}
        <button type="submit" className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-2 font-semibold text-white hover:bg-cyan-500">
          <Save className="h-3.5 w-3.5" />Зберегти пресет ({selectedBlocks.length})
        </button>
      </form>}
      <div className="mt-3 flex flex-wrap gap-2">
        {presets.map(preset => <div key={preset.id} className="flex min-w-0 max-w-full items-center overflow-hidden rounded-lg border border-slate-700 bg-slate-900">
          <button type="button" title={preset.blocks.map(block => `${block.symbol} (${block.exchange} ${block.marketType})`).join(', ')}
            onClick={() => { onLoadPreset(preset); setMessage(`Відкрито пресет «${preset.name}».`); }} className="flex min-w-0 items-center gap-2 px-3 py-2 text-slate-200 hover:bg-slate-800">
            <Star className="h-3.5 w-3.5 shrink-0 text-amber-400" /><span className="min-w-0 max-w-48 truncate">{preset.name}</span><span className="text-slate-500">{preset.blocks.length}</span>
          </button>
          <button type="button" aria-label={`Видалити пресет ${preset.name}`} title="Видалити пресет" onClick={() => { onDeletePreset(preset.id); setMessage(`Пресет «${preset.name}» видалено.`); }}
            className="shrink-0 border-l border-slate-700 p-2 text-slate-500 hover:bg-rose-500/10 hover:text-rose-300"><Trash2 className="h-3.5 w-3.5" /></button>
        </div>)}
        {!presets.length && !showForm && <p className="py-1 text-slate-500">Збережіть власний набір монет, щоб відкривати його одним натисканням.</p>}
      </div>
    </div>}
  </section>;
}
