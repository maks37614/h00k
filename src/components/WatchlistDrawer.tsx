import React, { useState } from 'react';
import { X, Trash2, Star, Zap, FolderPlus, ArrowUpDown, ChevronDown, ChevronUp } from 'lucide-react';
import type { ScannedCoin } from '../types';
import { resolveWatchlistEntries } from '../utils/watchlistUtils';
import type { ResolvedWatchlistEntry } from '../utils/watchlistUtils';
import { formatCryptoPrice } from '../utils/formatters';

interface WatchlistDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  watchlistSymbols: string[];
  allCoins: ScannedCoin[];
  onRemove: (sourceKeys: string[]) => void;
  folders: Record<string, string[]>;
  onFoldersChange: (folders: Record<string, string[]>) => void;
  onSendMetaScalp?: (coin: ScannedCoin) => void;
  metaScalpBinding?: string;
}

export const WatchlistDrawer: React.FC<WatchlistDrawerProps> = ({
  isOpen,
  onClose,
  watchlistSymbols,
  allCoins,
  onRemove,
  folders,
  onFoldersChange,
  onSendMetaScalp,
  metaScalpBinding = '001',
}) => {
  const [newFolderName, setNewFolderName] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'price' | 'change' | 'volume'>('name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});

  if (!isOpen) return null;

  const entries = resolveWatchlistEntries(watchlistSymbols, allCoins);
  const folderNames = Object.keys(folders);
  const getFolderForEntry = (entry: ResolvedWatchlistEntry) =>
    folderNames.find((folder) => {
      const symbols = Array.isArray(folders[folder]) ? folders[folder] : [];
      return symbols.some((key) => key === entry.key || entry.sourceKeys.includes(key));
    }) || '';
  const sortEntries = (items: ResolvedWatchlistEntry[]) => [...items].sort((a, b) => {
    let result = 0;
    if (sortBy === 'name') result = a.symbol.localeCompare(b.symbol);
    if (sortBy === 'price') result = (a.coin?.currentPrice ?? 0) - (b.coin?.currentPrice ?? 0);
    if (sortBy === 'change') result = (a.coin?.priceChange24h ?? 0) - (b.coin?.priceChange24h ?? 0);
    if (sortBy === 'volume') result = (a.coin?.volume24hUsd ?? 0) - (b.coin?.volume24hUsd ?? 0);
    return sortDirection === 'asc' ? result : -result;
  });
  const groups = folderNames.map((folder) => ({
    name: folder,
    entries: sortEntries(entries.filter((entry) => getFolderForEntry(entry) === folder)),
  }));
  groups.push({
    name: '',
    entries: sortEntries(entries.filter((entry) => !getFolderForEntry(entry))),
  });

  const createFolder = () => {
    const name = newFolderName.trim();
    if (!name || folders[name]) return;
    onFoldersChange({ ...folders, [name]: [] });
    setNewFolderName('');
  };

  const moveCoin = (entry: ResolvedWatchlistEntry, folder: string) => {
    const aliases = new Set([...entry.sourceKeys, entry.key]);
    const next: Record<string, string[]> = {};
    Object.entries(folders).forEach(([name, symbols]) => {
      next[name] = (Array.isArray(symbols) ? symbols : []).filter((item) => !aliases.has(item));
    });
    if (folder) next[folder] = [...(next[folder] || []), entry.key];
    onFoldersChange(next);
  };

  const removeCoin = (entry: ResolvedWatchlistEntry) => {
    // Explicit removal never toggles an unavailable favorite back on.
    onRemove(entry.sourceKeys);
    moveCoin(entry, '');
  };

  const formatPrice = (price: number) => formatCryptoPrice(price);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md bg-slate-900 border-l border-slate-800 h-full flex flex-col shadow-2xl animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-950/80">
          <div className="flex items-center gap-2">
            <Star className="w-4 h-4 text-amber-400 fill-amber-400" />
            <h3 className="font-bold text-white text-sm">Обрані монети</h3>
            <span className="px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 text-xs font-mono">
              {entries.length}
            </span>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-4 py-3 border-b border-slate-800 bg-slate-900/80 space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-center gap-1.5 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1">
              <FolderPlus className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
              <input
                value={newFolderName}
                onChange={(event) => setNewFolderName(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && createFolder()}
                placeholder="Нова папка"
                className="min-w-0 flex-1 bg-transparent text-xs text-slate-200 outline-none placeholder:text-slate-600"
              />
            </div>
            <button
              onClick={createFolder}
              className="px-2.5 py-1.5 rounded-lg bg-cyan-500/15 text-cyan-300 text-xs font-semibold hover:bg-cyan-500/25 transition-colors"
            >
              Додати
            </button>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <ArrowUpDown className="w-3.5 h-3.5 text-slate-500" />
            <select
              value={sortBy}
              onChange={(event) => setSortBy(event.target.value as typeof sortBy)}
              className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-slate-300 outline-none"
            >
              <option value="name">За назвою</option>
              <option value="price">За ціною</option>
              <option value="change">За зміною 24г</option>
              <option value="volume">За об'ємом</option>
            </select>
            <button
              onClick={() => setSortDirection((direction) => direction === 'asc' ? 'desc' : 'asc')}
              className="px-2 py-1 rounded-lg bg-slate-950 border border-slate-800 text-slate-300 hover:text-white transition-colors"
              title="Змінити напрямок сортування"
            >
              {sortDirection === 'asc' ? '↑' : '↓'}
            </button>
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto touch-scroll p-4 space-y-3">
          {entries.length === 0 ? (
            <div className="text-center py-12 text-slate-500 text-xs space-y-2">
              <Star className="w-8 h-8 text-slate-700 mx-auto" />
              <p>В обраному поки немає монет</p>
              <p className="text-[11px] text-slate-600">
                Натисніть на зірочку біля будь-якої монети в скринері, щоб додати її сюди.
              </p>
            </div>
          ) : (
            groups.filter((group) => group.entries.length > 0).map((group) => (
              <div key={group.name || 'unfiled'} className="space-y-2">
                <button
                  onClick={() => setCollapsedFolders((current) => ({
                    ...current,
                    [group.name || 'unfiled']: !current[group.name || 'unfiled'],
                  }))}
                  className="w-full flex items-center gap-2 text-[11px] font-semibold text-slate-400 hover:text-slate-200 transition-colors"
                >
                  <Star className="w-3.5 h-3.5 text-amber-400" />
                  {group.name || 'Без папки'}
                  <span className="text-slate-600 font-mono">{group.entries.length}</span>
                  <span className="ml-auto">
                    {collapsedFolders[group.name || 'unfiled'] ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
                  </span>
                </button>
                {!collapsedFolders[group.name || 'unfiled'] && group.entries.map((entry, index) => (
              <div
                key={`${entry.key}-${index}`}
                className="bg-slate-950/70 border border-slate-800 hover:border-slate-700 rounded-xl p-3 space-y-2.5 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-sm text-white">
                      {entry.coin?.baseAsset || entry.symbol.replace(/(USDT|USDC|BUSD)$/, '') || entry.symbol}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded font-semibold uppercase bg-slate-800 text-slate-400">
                      {entry.exchange}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {entry.coin ? (
                      <span className="font-mono font-bold text-xs text-white">${formatPrice(entry.coin.currentPrice)}</span>
                    ) : (
                      <span className="text-[10px] font-medium text-amber-300" title="Ця монета збережена, але відсутня в поточному скануванні">Немає даних</span>
                    )}
                    {onSendMetaScalp && entry.coin && (
                      <button
                        onClick={() => entry.coin && onSendMetaScalp(entry.coin)}
                        title={`Відкрити в MetaScalp [${metaScalpBinding}]`}
                        className="text-amber-400/80 hover:text-amber-300 p-1 rounded hover:bg-amber-500/10 transition-colors"
                      >
                        <Zap className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <select
                      value={getFolderForEntry(entry)}
                      onChange={(event) => moveCoin(entry, event.target.value)}
                      className="max-w-[90px] bg-slate-900 border border-slate-800 rounded px-1 py-0.5 text-[10px] text-slate-400 outline-none"
                      title="Перемістити в папку"
                    >
                      <option value="">Без папки</option>
                      {folderNames.map((folder) => <option key={folder} value={folder}>{folder}</option>)}
                    </select>
                    <button
                      onClick={() => removeCoin(entry)}
                      title="Видалити з обраного"
                      className="text-slate-500 hover:text-rose-400 p-1 rounded hover:bg-slate-800 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                {!entry.coin && (
                  <div className="flex flex-wrap items-center gap-1 text-[10px] text-amber-300/80">
                    <span>Недоступна у поточному скануванні:</span>
                    <span className="font-mono">{entry.symbol}</span>
                    <span className="font-mono text-slate-500">· {entry.marketType}</span>
                    <span className="text-slate-500">— можна видалити кнопкою кошика</span>
                  </div>
                )}
              </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
