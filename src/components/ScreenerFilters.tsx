import React, { useState } from 'react';
import { Search, SlidersHorizontal, LayoutGrid, List, ArrowUpDown, ArrowDown, ArrowUp, ChevronDown } from 'lucide-react';
import { ScreenerFilterState, ExchangeId, MarketType, Timeframe, PatternCategory, PatternBias, PatternStatus } from '../types';
import { useLanguage } from '../context/LanguageContext';
import type { EarlyStageFilter } from '../utils/earlyFormationList';
import { countActiveRegularIndicatorFilters, DEFAULT_REGULAR_INDICATOR_FILTERS, type RegularIndicatorFilters } from '../utils/regularFormationIndicators';

interface ScreenerFiltersProps {
  filters: ScreenerFilterState;
  onFilterChange: (newFilters: Partial<ScreenerFilterState>) => void;
  viewMode: 'grid' | 'table';
  onViewModeChange: (mode: 'grid' | 'table') => void;
  earlyMode?: boolean;
  earlyStage?: EarlyStageFilter;
  onEarlyStageChange?: (stage: EarlyStageFilter) => void;
  regularIndicatorFilters?: RegularIndicatorFilters;
  onRegularIndicatorFilterChange?: (changes: Partial<RegularIndicatorFilters>) => void;
  onResetRegularIndicatorFilters?: () => void;
}

export const ScreenerFilters: React.FC<ScreenerFiltersProps> = ({
  filters,
  onFilterChange,
  viewMode,
  onViewModeChange,
  earlyMode = false,
  earlyStage = 'all',
  onEarlyStageChange,
  regularIndicatorFilters = DEFAULT_REGULAR_INDICATOR_FILTERS,
  onRegularIndicatorFilterChange,
  onResetRegularIndicatorFilters,
}) => {
  const { t } = useLanguage();
  const [isTechnicalFiltersOpen, setIsTechnicalFiltersOpen] = useState(false);
  const activeTechnicalFilters = countActiveRegularIndicatorFilters(regularIndicatorFilters);

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4 space-y-4">
      {/* Row 1: Search and timeframe */}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <div className="relative w-full sm:w-56">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            placeholder={t('search')}
            value={filters.searchQuery}
            onChange={(e) => onFilterChange({ searchQuery: e.target.value })}
            className="w-full pl-9 pr-3 py-1.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors uppercase font-mono"
          />
        </div>
        <div className="inline-flex w-fit items-center bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs font-mono">
          {(earlyMode
            ? (['1m', '5m', '15m', '1h', '4h', '1d'] as Timeframe[])
            : (['5m', '15m', '1h', '4h', '1d'] as Timeframe[])
          ).map((tf) => (
            <button
              key={tf}
              onClick={() => onFilterChange({ timeframe: tf })}
              className={`px-2.5 py-1.5 rounded-lg font-medium transition-all ${
                filters.timeframe === tf
                  ? 'bg-cyan-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>

      {/* Row 2: Exchange and market */}
      <div className="flex flex-wrap items-center justify-center gap-2">
        {/* Exchange Selector */}
        <div className="inline-flex w-fit items-center bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs">
          <button
            onClick={() => onFilterChange({ exchange: 'all' })}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
              filters.exchange === 'all'
                ? 'bg-slate-800 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t('allExchanges')}
          </button>
          <button
            onClick={() => onFilterChange({ exchange: 'binance' })}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition-all ${
              filters.exchange === 'binance'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 font-semibold shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-amber-400" />
            Binance
          </button>
          <button
            onClick={() => onFilterChange({ exchange: 'bybit' })}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition-all ${
              filters.exchange === 'bybit'
                ? 'bg-orange-500/20 text-orange-300 border border-orange-500/30 font-semibold shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-orange-400" />
            Bybit
          </button>
        </div>

        {/* Market Type */}
        <div className="inline-flex w-fit items-center bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs">
          <button
            onClick={() => onFilterChange({ marketType: 'all' })}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
              filters.marketType === 'all'
                ? 'bg-slate-800 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t('allMarkets')}
          </button>
          <button
            onClick={() => onFilterChange({ marketType: 'futures' })}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
              filters.marketType === 'futures'
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 font-semibold shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t('futures')}
          </button>
          <button
            onClick={() => onFilterChange({ marketType: 'spot' })}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
              filters.marketType === 'spot'
                ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-semibold shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t('spot')}
          </button>
        </div>
      </div>

      {/* Row 3: Categories, Direction, Status, Min Volume, View Mode */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-800/60 text-xs">
        {/* Category filters apply only to the regular formation scanner. */}
        {!earlyMode && <div className="flex items-center flex-wrap gap-1.5">
          <span className="text-slate-400 text-[11px] font-medium mr-1 flex items-center gap-1">
            <SlidersHorizontal className="w-3 h-3 text-slate-400" />
            {t('formations')}
          </span>
          {[
            { id: 'all', label: t('all') },
            { id: 'reversal', label: t('reversal') },
            { id: 'breakout', label: t('breakout') },
            { id: 'continuation', label: t('continuation') },
            { id: 'compression', label: t('compression') },
            { id: 'candlestick', label: t('candlestick') },
          ].map((cat) => (
            <button
              key={cat.id}
              onClick={() => onFilterChange({ category: cat.id as any })}
              className={`px-2.5 py-1 rounded-lg text-[11px] transition-all ${
                filters.category === cat.id
                  ? 'bg-slate-700 text-white font-medium shadow-sm'
                  : 'bg-slate-950 text-slate-400 hover:text-slate-200 hover:bg-slate-900 border border-slate-800/80'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>}

        {/* W/M keeps useful direction, volume and sorting controls. */}
        <div className={`flex items-center flex-wrap gap-2 ${earlyMode ? 'w-full justify-center' : 'ml-auto'}`}>
          {/* Bias / Direction */}
          {earlyMode && <span className="text-slate-400 text-[11px] font-medium">Напрямок W/M</span>}
          <div className="flex items-center bg-slate-950 p-0.5 rounded-lg border border-slate-800 text-[11px]" role="group"
            aria-label={earlyMode ? 'Напрямок ранньої W/M' : 'Напрямок формації'}>
            <button
              onClick={() => onFilterChange({ bias: 'all' })}
              className={`px-2 py-1 rounded ${filters.bias === 'all' ? 'bg-slate-800 text-white' : 'text-slate-400'}`}
            >
              {earlyMode ? 'Усі W/M' : t('all')}
            </button>
            <button
              onClick={() => onFilterChange({ bias: 'bullish' })}
              className={`px-2 py-1 rounded ${filters.bias === 'bullish' ? 'bg-emerald-500/20 text-emerald-300 font-semibold' : 'text-slate-400'}`}
            >
              {earlyMode ? '▲ W · LONG' : t('long')}
            </button>
            <button
              onClick={() => onFilterChange({ bias: 'bearish' })}
              className={`px-2 py-1 rounded ${filters.bias === 'bearish' ? 'bg-rose-500/20 text-rose-300 font-semibold' : 'text-slate-400'}`}
            >
              {earlyMode ? '▼ M · SHORT' : t('short')}
            </button>
          </div>

          {earlyMode && onEarlyStageChange && (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Стадія ранньої формації">
              <span className="text-slate-400 text-[11px] font-medium">Стадія</span>
              <div className="flex items-center bg-slate-950 p-0.5 rounded-lg border border-slate-800 text-[11px]">
                {([
                  { value: 'all', label: 'Усі' },
                  { value: 'potential', label: 'Потенційна' },
                  { value: 'forming', label: 'Формується' },
                ] as const).map(item => (
                  <button key={item.value} type="button" aria-pressed={earlyStage === item.value}
                    onClick={() => onEarlyStageChange(item.value)}
                    className={`px-2 py-1 rounded transition-colors ${earlyStage === item.value
                      ? 'bg-amber-500/20 text-amber-200 font-semibold' : 'text-slate-400 hover:text-slate-200'}`}>
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {!earlyMode && <>
          <label
            className="flex items-center gap-1.5 bg-slate-950 px-2 py-1 rounded-lg border border-slate-800 text-[11px] text-slate-300 cursor-pointer"
            title="Лише формації з аномальною лімітною заявкою біля круглого рівня у поточному знімку стакана. Це не доказ, що заявка залишиться на ринку."
          >
            <input
              type="checkbox"
              checked={filters.densityConfirmedOnly}
              onChange={(e) => onFilterChange({ densityConfirmedOnly: e.target.checked })}
              className="accent-fuchsia-400"
            />
            Щільність підтверджена
          </label>

          <label className="flex items-center gap-1.5 bg-slate-950 px-2 py-1 rounded-lg border border-slate-800 text-[11px] text-slate-300">
            Статус
            <select
              value={filters.status}
              onChange={(e) => onFilterChange({ status: e.target.value as ScreenerFilterState['status'] })}
              className="bg-transparent text-slate-200 focus:outline-none cursor-pointer"
            >
              <option value="all" className="bg-slate-900">Усі</option>
              <option value="forming" className="bg-slate-900">Формується</option>
              <option value="ready_to_break" className="bg-slate-900">Очікує пробою</option>
              <option value="breakout" className="bg-slate-900">Пробій</option>
              <option value="retest" className="bg-slate-900">Ретест</option>
              <option value="target_reached" className="bg-slate-900">Ціль досягнуто</option>
            </select>
          </label>

          </>}

          {/* Minimum volume also controls which USDT pairs get scanned in early mode. */}
          <div className="flex items-center bg-slate-950 px-2 py-1 rounded-lg border border-slate-800 text-[11px] text-slate-300">
            <span className="text-slate-500 mr-1.5">{t('minVolume')}</span>
            <select
              value={filters.minVolumeUsd}
              onChange={(e) => onFilterChange({ minVolumeUsd: Number(e.target.value) })}
              className="bg-transparent border-none text-slate-200 focus:outline-none cursor-pointer"
            >
              <option value={0} className="bg-slate-900">{t('allCoinsVol')}</option>
              <option value={50000} className="bg-slate-900">Від $50k</option>
              <option value={100000} className="bg-slate-900">Від $100k</option>
              <option value={300000} className="bg-slate-900">Від $300k</option>
              <option value={500000} className="bg-slate-900">Від $500k</option>
              <option value={1000000} className="bg-slate-900">Від $1M</option>
              <option value={5000000} className="bg-slate-900">Від $5M+</option>
              <option value={20000000} className="bg-slate-900">Від $20M</option>
              <option value={50000000} className="bg-slate-900">Від $50M</option>
              <option value={100000000} className="bg-slate-900">Від $100M</option>
              <option value={500000000} className="bg-slate-900">Від $500M</option>
              <option value={1000000000} className="bg-slate-900">Від $1B</option>
            </select>
          </div>

          {/* Sort By */}
          <div className="flex items-center bg-slate-950 px-2 py-1 rounded-lg border border-slate-800 text-[11px] text-slate-300">
            <ArrowUpDown className="w-3 h-3 text-slate-500 mr-1.5" />
            <select
              value={filters.sortBy}
              onChange={(e) => onFilterChange({ sortBy: e.target.value as any })}
              className="bg-transparent border-none text-slate-200 focus:outline-none cursor-pointer"
            >
              <option value="confidence" className="bg-slate-900">{earlyMode ? 'За стадією' : t('byConfidence')}</option>
              <option value="volume" className="bg-slate-900">{t('byVolume')}</option>
              <option value="priceChange" className="bg-slate-900">{t('byPriceChange')}</option>
              <option value="profitPotential" className="bg-slate-900">{earlyMode ? 'За R:R раннього входу' : 'За прибутком до TP (%)'}</option>
            </select>
          </div>

          <button
            type="button"
            onClick={() => onFilterChange({ sortOrder: filters.sortOrder === 'desc' ? 'asc' : 'desc' })}
            className="flex items-center justify-center bg-slate-950 p-2 rounded-lg border border-slate-800 text-slate-300 hover:text-white"
            title={filters.sortOrder === 'desc' ? 'Спадання — змінити на зростання' : 'Зростання — змінити на спадання'}
            aria-label={filters.sortOrder === 'desc' ? 'Сортувати за зростанням' : 'Сортувати за спаданням'}
          >
            {filters.sortOrder === 'desc' ? <ArrowDown className="w-3.5 h-3.5" /> : <ArrowUp className="w-3.5 h-3.5" />}
          </button>

          {/* Early W/M has cards only; the table toggle would have no effect. */}
          {!earlyMode && <div className="flex items-center bg-slate-950 p-1 rounded-lg border border-slate-800">
            <button
              onClick={() => onViewModeChange('grid')}
              title={t('viewCards')}
              className={`p-1 rounded ${viewMode === 'grid' ? 'bg-slate-800 text-cyan-400' : 'text-slate-500 hover:text-slate-300'}`}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => onViewModeChange('table')}
              title={t('viewTable')}
              className={`p-1 rounded ${viewMode === 'table' ? 'bg-slate-800 text-cyan-400' : 'text-slate-500 hover:text-slate-300'}`}
            >
              <List className="w-3.5 h-3.5" />
            </button>
          </div>}
        </div>
      </div>

      {/* Technical indicators belong exclusively to ordinary formation screening. */}
      {!earlyMode && onRegularIndicatorFilterChange && (
        <div className="border-t border-slate-800/60 pt-3 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button type="button" aria-expanded={isTechnicalFiltersOpen}
              aria-controls="regular-technical-filters"
              onClick={() => setIsTechnicalFiltersOpen(open => !open)}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 text-xs font-semibold text-cyan-200 hover:border-cyan-600 hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400">
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
              Технічні фільтри · ATR / RVOL / RSI / OI / Дельта
              {activeTechnicalFilters > 0 && (
                <span className="rounded-full bg-cyan-500/20 px-1.5 py-0.5 text-[10px] text-cyan-200">
                  {activeTechnicalFilters} активні
                </span>
              )}
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${isTechnicalFiltersOpen ? 'rotate-180' : ''}`}
                aria-hidden="true" />
            </button>
            {activeTechnicalFilters > 0 && onResetRegularIndicatorFilters && (
              <button type="button" onClick={onResetRegularIndicatorFilters}
                className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-[11px] text-slate-300 hover:text-white hover:bg-slate-800">
                Скинути технічні
              </button>
            )}
          </div>

          {isTechnicalFiltersOpen && (
            <div id="regular-technical-filters" className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <label className="space-y-1 text-[11px] text-slate-300">
                <span className="font-semibold text-slate-300">ATR (14) · % ціни</span>
                <select value={regularIndicatorFilters.atrBand}
                  onChange={event => onRegularIndicatorFilterChange({ atrBand: event.target.value as RegularIndicatorFilters['atrBand'] })}
                  className="block w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-2 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none">
                  <option value="all">Будь-яка волатильність</option>
                  <option value="low">Низька: менше 0,5%</option>
                  <option value="medium">Помірна: 0,5–1,5%</option>
                  <option value="high">Висока: 1,5–3%</option>
                  <option value="veryHigh">Дуже висока: від 3%</option>
                </select>
              </label>
              <label className="space-y-1 text-[11px] text-slate-300">
                <span className="font-semibold text-slate-300">RVOL · обсяг свічки пробою</span>
                <select value={regularIndicatorFilters.minBreakoutRvol}
                  onChange={event => onRegularIndicatorFilterChange({
                    minBreakoutRvol: Number(event.target.value) as RegularIndicatorFilters['minBreakoutRvol'],
                  })}
                  className="block w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-2 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none">
                  <option value={0}>Будь-який · без вимоги пробою</option>
                  <option value={1}>Від 1,0×</option>
                  <option value={1.2}>Від 1,2×</option>
                  <option value={1.5}>Від 1,5×</option>
                  <option value={2}>Від 2,0×</option>
                </select>
              </label>
              <label className="space-y-1 text-[11px] text-slate-300">
                <span className="font-semibold text-slate-300">RSI (14) · остання закрита свічка</span>
                <select value={regularIndicatorFilters.rsiZone}
                  onChange={event => onRegularIndicatorFilterChange({ rsiZone: event.target.value as RegularIndicatorFilters['rsiZone'] })}
                  className="block w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-2 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none">
                  <option value="all">Будь-який RSI</option>
                  <option value="oversold">Перепроданість: менше 30</option>
                  <option value="bearish">Слабкість: 30–45</option>
                  <option value="neutral">Нейтральний: 45–55</option>
                  <option value="bullish">Сила: 55–70</option>
                  <option value="overbought">Перекупленість: від 70</option>
                </select>
              </label>
              <label className="space-y-1 text-[11px] text-slate-300">
                <span className="font-semibold text-slate-300">Open Interest · Δ за TF (ф'ючерси)</span>
                <select value={regularIndicatorFilters.oiChange}
                  onChange={event => onRegularIndicatorFilterChange({
                    oiChange: event.target.value as RegularIndicatorFilters['oiChange'],
                  })}
                  className="block w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-2 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none">
                  <option value="all">Не враховувати OI</option>
                  <option value="rising">Зростання OI ≥ 1%</option>
                  <option value="falling">Падіння OI ≤ −1%</option>
                  <option value="stable">Стабільний OI: від −1% до +1%</option>
                </select>
              </label>
              <label className="space-y-1 text-[11px] text-slate-300">
                <span className="font-semibold text-slate-300">Дельта · остання свічка (Binance)</span>
                <select value={regularIndicatorFilters.delta}
                  onChange={event => onRegularIndicatorFilterChange({
                    delta: event.target.value as RegularIndicatorFilters['delta'],
                  })}
                  className="block w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-2 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none">
                  <option value="all">Не враховувати дельту</option>
                  <option value="positive">Перевага покупців: більше 0%</option>
                  <option value="negative">Перевага продавців: менше 0%</option>
                  <option value="strongPositive">Сильні покупки: від +20%</option>
                  <option value="strongNegative">Сильні продажі: до −20%</option>
                </select>
              </label>
              <label className="space-y-1 text-[11px] text-slate-300">
                <span className="font-semibold text-slate-300">CVD · останні 20 свічок (Binance)</span>
                <select value={regularIndicatorFilters.cvd20}
                  onChange={event => onRegularIndicatorFilterChange({
                    cvd20: event.target.value as RegularIndicatorFilters['cvd20'],
                  })}
                  className="block w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-2 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none">
                  <option value="all">Не враховувати CVD</option>
                  <option value="positive">Додатна накопичена дельта</option>
                  <option value="negative">Від'ємна накопичена дельта</option>
                </select>
              </label>
              <p className="sm:col-span-3 text-[10px] leading-4 text-slate-500">
                OI доступний тільки для ф'ючерсів (5m, 15m, 1h, 4h, 1d) за умови
                безперервних актуальних записів біржі. Дельта і CVD(20) — лише Binance
                Spot/Futures з реальних taker buy/sell обсягів; неповний Bybit потік
                не використовується. За відсутності даних активний фільтр приховає монету.
              </p>
              <p className="sm:col-span-3 text-[10px] leading-4 text-slate-500">
                Показники розраховуються тільки із закритих свічок обраного таймфрейму.
                RVOL порівнює обсяг свічки підтвердженого пробою з 20 попередніми;
                при ввімкненому RVOL формації без пробою приховуються.
                Якщо для монети немає достовірних даних, активний фільтр її не пропускає.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
