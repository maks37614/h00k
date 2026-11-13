import React from 'react';
import type { DetectedFormation, ExchangeId, Kline, MarketType, Timeframe } from '../types';
import { TradingViewChart } from './TradingViewChart';
import type { VisualChartProfile, VisualContextId } from './hookchart/visualProfiles';
import type { TerminalToolbarVisibility } from './hookchart/HookChartCanvas';

const EMPTY_HISTORY: Kline[] = [];

interface ExchangeCandlestickChartProps {
  symbol: string;
  exchange: ExchangeId;
  marketType: MarketType;
  timeframe: string;
  historyLimit?: number;
  terminalMode?: boolean;
  terminalAutoScale?: boolean;
  terminalInitialView?: VisualChartProfile;
  visualContext?: VisualContextId;
  terminalToolbarVisibility?: TerminalToolbarVisibility;
  hookchartToolbarActions?: React.ReactNode;
  hookchartToolbarOverlays?: React.ReactNode;
  formation?: DetectedFormation | null;
  onTimeframeChange?: (timeframe: Timeframe) => void;
  onLivePriceUpdate?: (price: number) => void;
}

export const ExchangeCandlestickChart: React.FC<ExchangeCandlestickChartProps> = ({
  symbol, exchange, marketType, timeframe, historyLimit = 1000, onTimeframeChange, onLivePriceUpdate,
  terminalMode, terminalAutoScale, terminalInitialView, visualContext, terminalToolbarVisibility, hookchartToolbarActions, hookchartToolbarOverlays, formation,
}) => (
  <div className="h-full w-full min-h-0" role="group" aria-label={`Графік ${symbol}`}>
    <TradingViewChart
      key={`${exchange}:${marketType}:${symbol}:${timeframe}`}
      klines={EMPTY_HISTORY}
      terminalMode={terminalMode}
      terminalAutoScale={terminalAutoScale}
      terminalInitialView={terminalInitialView}
      visualContext={visualContext}
      terminalToolbarVisibility={terminalToolbarVisibility}
      hookchartToolbarActions={hookchartToolbarActions}
      hookchartToolbarOverlays={hookchartToolbarOverlays}
      formation={formation}
      symbol={symbol}
      exchange={exchange}
      marketType={marketType}
      timeframe={timeframe}
      onTimeframeChange={onTimeframeChange}
      onLivePriceUpdate={onLivePriceUpdate}
      historyLimit={historyLimit}
      fullHeight
      showNavigationControls={false}
      hideSymbolAndPrice
    />
  </div>
);
