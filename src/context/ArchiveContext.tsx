import React, { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useAuth } from './AuthContext';
import {
  ArchivedFormation,
  ScannedCoin,
  DetectedFormation,
  Timeframe,
  ChartMarkerInfo,
  ChartRestoreParams,
} from '../types';
import { apiJson } from '../utils/apiFetch';
import { normalizeChartDocument, type ChartDocument } from '../community/chartDocument';

interface SaveArchiveOptions {
  chartDocument?: ChartDocument;
  sourceChartId?: string;
  timeframe?: Timeframe;
  historyLimit?: number;
  markers?: ChartMarkerInfo[];
  chartParams?: Partial<ChartRestoreParams>;
  notes?: string;
  currentPrice?: number;
}

interface ArchiveContextType {
  archivedFormations: ArchivedFormation[];
  loading: boolean;
  saveToArchive: (
    coin: ScannedCoin,
    formation: DetectedFormation,
    options?: SaveArchiveOptions
  ) => Promise<ArchivedFormation>;
  removeFromArchive: (id: string) => Promise<boolean>;
  clearUserArchive: () => Promise<boolean>;
  isArchived: (symbol: string, formationIdOrName: string) => boolean;
  getArchivedItem: (symbol: string, formationIdOrName: string) => ArchivedFormation | undefined;
  archiveCount: number;
}

const ArchiveContext = createContext<ArchiveContextType | undefined>(undefined);

export const ArchiveProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const currentOwner = useRef(user?.uid);
  currentOwner.current = user?.uid;
  const [archivedFormations, setArchivedFormations] = useState<ArchivedFormation[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let active = true; setArchivedFormations([]);
    if (!user) { setLoading(false); return; }
    setLoading(true);
    const reload = () => { void apiJson('/api/community/archives').then(data => { if (active) setArchivedFormations(data.items ?? []); }).catch(() => {}).finally(() => { if (active) setLoading(false); }); };
    reload(); window.addEventListener('h00k:archive-saved', reload);
    return () => { active = false; window.removeEventListener('h00k:archive-saved', reload); };
  }, [user?.uid]);

  // Check if a specific coin + formation is already in archive
  const isArchived = useCallback(
    (symbol: string, formationIdOrName: string) => {
      const cleanSym = symbol.toUpperCase().replace('/', '').trim();
      return archivedFormations.some((item) => {
        const itemSym = item.symbol.toUpperCase().replace('/', '').trim();
        return (
          itemSym === cleanSym &&
          (item.formation.id === formationIdOrName ||
            item.formation.name === formationIdOrName ||
            item.formationName === formationIdOrName)
        );
      });
    },
    [archivedFormations]
  );

  const getArchivedItem = useCallback(
    (symbol: string, formationIdOrName: string) => {
      const cleanSym = symbol.toUpperCase().replace('/', '').trim();
      return archivedFormations.find((item) => {
        const itemSym = item.symbol.toUpperCase().replace('/', '').trim();
        return (
          itemSym === cleanSym &&
          (item.formation.id === formationIdOrName ||
            item.formation.name === formationIdOrName ||
            item.formationName === formationIdOrName)
        );
      });
    },
    [archivedFormations]
  );

  // Save formation to archive
  const saveToArchive = useCallback(
    async (
      coin: ScannedCoin,
      formation: DetectedFormation,
      options?: SaveArchiveOptions
    ): Promise<ArchivedFormation> => {
      if (!user) {
        throw new Error('Увійдіть у профіль, щоб зберегти формацію у свій особистий архів');
      }
      const currentUserId = user.uid;
      const snapshot = options?.chartDocument ? normalizeChartDocument(options.chartDocument) : undefined;
      if (snapshot) {
        coin = { ...coin, symbol: snapshot.symbol, exchange: snapshot.exchange, marketType: snapshot.marketType, timeframe: snapshot.timeframe };
        const original = JSON.parse(JSON.stringify(formation));
        const level = (type: string, fallback: number) => snapshot.markers.find(marker => marker.type === type)?.price ?? fallback;
        formation = { ...original, levels: { ...original.levels, entryPrice: level('entry', original.levels.entryPrice),
          targetPrice: level('target', original.levels.targetPrice), stopLossPrice: level('stop_loss', original.levels.stopLossPrice) } };
      }
      const cleanSym = coin.symbol.toUpperCase().replace('/', '').trim();
      const timestamp = Date.now();
      const uniqueId = `arch_${cleanSym.toLowerCase()}_${formation.patternKey || 'p'}_${timestamp}`;

      const activeTimeframe = snapshot?.timeframe || options?.timeframe || coin.timeframe || '1h';
      const activeLimit = options?.historyLimit || 500;
      const refPrice = options?.currentPrice || coin.currentPrice || formation.levels.entryPrice;

      // Construct comprehensive markers list
      const markersList: ChartMarkerInfo[] = snapshot ? snapshot.markers : options?.markers && options.markers.length > 0
        ? options.markers
        : [
            {
              id: `marker_entry_${uniqueId}`,
              type: 'entry',
              label: `Вхід: $${formation.levels.entryPrice}`,
              price: formation.levels.entryPrice,
              color: '#38bdf8',
              lineStyle: 'dashed',
              lineWidth: 2,
              notes: 'Точка входу в позицію за формацією',
            },
            {
              id: `marker_target_${uniqueId}`,
              type: 'target',
              label: `Ціль (Тейк): $${formation.levels.targetPrice}`,
              price: formation.levels.targetPrice,
              color: '#10b981',
              lineStyle: 'solid',
              lineWidth: 2,
              notes: `Очікуваний прибуток +${Math.abs(formation.potentialProfitPct)}%`,
            },
            {
              id: `marker_stop_${uniqueId}`,
              type: 'stop_loss',
              label: `Стоп-лосс: $${formation.levels.stopLossPrice}`,
              price: formation.levels.stopLossPrice,
              color: '#ef4444',
              lineStyle: 'solid',
              lineWidth: 2,
              notes: `Ризик -${Math.abs(formation.potentialRiskPct)}%`,
            },
          ];

      if (!snapshot && formation.levels.necklinePrice) {
        markersList.push({
          id: `marker_neckline_${uniqueId}`,
          type: 'neckline',
          label: `Лінія шиї: $${formation.levels.necklinePrice}`,
          price: formation.levels.necklinePrice,
          color: '#f59e0b',
          lineStyle: 'dotted',
          lineWidth: 1,
        });
      }

      if (!snapshot && formation.levels.resistancePrice) {
        markersList.push({
          id: `marker_res_${uniqueId}`,
          type: 'resistance',
          label: `Опір: $${formation.levels.resistancePrice}`,
          price: formation.levels.resistancePrice,
          color: '#f59e0b',
          lineStyle: 'dotted',
          lineWidth: 1,
        });
      }

      if (!snapshot && formation.levels.supportPrice) {
        markersList.push({
          id: `marker_sup_${uniqueId}`,
          type: 'support',
          label: `Підтримка: $${formation.levels.supportPrice}`,
          price: formation.levels.supportPrice,
          color: '#a855f7',
          lineStyle: 'dotted',
          lineWidth: 1,
        });
      }

      const chartParams: ChartRestoreParams = {
        timeframe: activeTimeframe,
        historyLimit: activeLimit,
        lastClosePrice: refPrice,
        visibleRange: snapshot?.viewport || options?.chartParams?.visibleRange || { from: 0, to: 80 },
        savedAtCandleTime: Math.floor(timestamp / 1000),
      };

      const newArchiveItem: ArchivedFormation = {
        id: uniqueId,
        userId: currentUserId,
        symbol: cleanSym,
        baseAsset: coin.baseAsset || cleanSym.replace('USDT', ''),
        quoteAsset: coin.quoteAsset || 'USDT',
        exchange: coin.exchange,
        marketType: coin.marketType,
        timeframe: activeTimeframe,
        formationName: formation.name,
        bias: formation.bias,
        confidence: formation.confidence,
        status: formation.status,
        entryPrice: formation.levels.entryPrice,
        targetPrice: formation.levels.targetPrice,
        stopLossPrice: formation.levels.stopLossPrice,
        necklinePrice: formation.levels.necklinePrice,
        resistancePrice: formation.levels.resistancePrice,
        supportPrice: formation.levels.supportPrice,
        savedPrice: refPrice,
        formation: { ...formation },
        markers: markersList,
        chartParams,
        ...(snapshot ? { chartDocument: snapshot } : {}),
        ...(options?.sourceChartId ? { sourceChartId: options.sourceChartId } : {}),
        notes: options?.notes || `${formation.name} • ${coin.exchange.toUpperCase()} • ${activeTimeframe}`,
        createdAt: new Date(timestamp).toISOString(),
        savedAtTimestamp: timestamp,
      };

      await apiJson('/api/community/archives', { method: 'POST', body: JSON.stringify(newArchiveItem) });
      if (currentOwner.current !== currentUserId) throw new Error('Акаунт змінився. Повторіть дію.');

      // Update state & user-scoped storage immediately
      setArchivedFormations((prev) => {
        const filtered = prev.filter((item) => item.id !== uniqueId);
        const updated = [newArchiveItem, ...filtered];
        try {
          localStorage.setItem(`signalhook_archive_${currentUserId}`, JSON.stringify(updated));
        } catch {}
        return updated;
      });

      return newArchiveItem;
    },
    [user]
  );

  // Remove formation from current user's archive
  const removeFromArchive = useCallback(
    async (id: string): Promise<boolean> => {
      if (!user) return false;
      const currentUserId = user.uid;
      await apiJson('/api/community/archives/' + encodeURIComponent(id), { method: 'DELETE' });
      if (currentOwner.current !== currentUserId) return false;

      setArchivedFormations((prev) => {
        const updated = prev.filter((item) => item.id !== id);
        try {
          localStorage.setItem(`signalhook_archive_${currentUserId}`, JSON.stringify(updated));
        } catch {}
        return updated;
      });

      return true;
    },
    [user]
  );

  // Clear all formations for current user only
  const clearUserArchive = useCallback(async (): Promise<boolean> => {
    if (!user) return false;
    const currentUserId = user.uid;
    await apiJson('/api/community/archives', { method: 'DELETE' });
    if (currentOwner.current !== currentUserId) return false;

    setArchivedFormations([]);
    try {
      localStorage.removeItem(`signalhook_archive_${currentUserId}`);
    } catch {}

    return true;
  }, [user]);

  const archiveCount = useMemo(() => archivedFormations.length, [archivedFormations]);

  return (
    <ArchiveContext.Provider
      value={{
        archivedFormations,
        loading,
        saveToArchive,
        removeFromArchive,
        clearUserArchive,
        isArchived,
        getArchivedItem,
        archiveCount,
      }}
    >
      {children}
    </ArchiveContext.Provider>
  );
};

export const useArchive = (): ArchiveContextType => {
  const context = useContext(ArchiveContext);
  if (!context) {
    throw new Error('useArchive must be used within an ArchiveProvider');
  }
  return context;
};
