import React from 'react';
import { MonitoringMenuIcon } from './MonitoringIcon';
import { ScreenerIcon, FormationsIcon, TerminalIcon } from './PageIcons';
import {
  RefreshCw,
  Bell,
  BellOff,
  Bookmark,
  BookOpen,
  Zap,
  Send,
  User,
  UserPlus,
  BarChart2,
  Globe,
  Lock,
  History,
  Maximize2,
} from 'lucide-react';
import { FormationArchiveIcon } from './FormationArchiveIcon';
import { MetaScalpSettings } from '../utils/metaScalpService';
import { useAuth } from '../context/AuthContext';
import { ActivePageType } from '../types';
import { useLanguage, SupportedLanguage } from '../context/LanguageContext';
import { toggleFullscreenSafe } from '../utils/fullscreenUtils';

interface HeaderProps {
  isLoading: boolean;
  totalCoins: number;
  formationsCount: number;
  bullishCount: number;
  bearishCount: number;
  watchlistCount: number;
  archiveCount?: number;
  soundEnabled: boolean;
  onToggleSound: () => void;
  onRefresh: () => void;
  onOpenWatchlist: () => void;
  onOpenArchive?: () => void;
  onOpenGuide: () => void;
  onOpenMetaScalp: () => void;
  metaScalpSettings?: MetaScalpSettings;
  lastUpdated: number | null;
  telegramAlertsCount?: number;
  surveillanceCount?: number;
  onOpenTelegramAlerts: () => void;
  onOpenAuth?: () => void;
  onOpenProfile?: () => void;
  activePage: ActivePageType;
  onPageChange: (page: ActivePageType) => void;
}

export const Header: React.FC<HeaderProps> = ({
  isLoading,
  totalCoins,
  formationsCount,
  bullishCount,
  bearishCount,
  watchlistCount,
  archiveCount = 0,
  soundEnabled,
  onToggleSound,
  onRefresh,
  onOpenWatchlist,
  onOpenArchive,
  onOpenGuide,
  onOpenMetaScalp,
  metaScalpSettings,
  lastUpdated,
  telegramAlertsCount = 0,
  surveillanceCount = 0,
  onOpenTelegramAlerts,
  onOpenAuth,
  onOpenProfile,
  activePage,
  onPageChange,
}) => {
  const { user, profile, updateProfileData } = useAuth();
  const { language, setLanguage, t } = useLanguage();

  const changeSiteLanguage = (nextLanguage: SupportedLanguage) => {
    setLanguage(nextLanguage);
    if (user) {
      void updateProfileData({ hookChartPreferences: {
        language: nextLanguage,
        siteLanguageAtSelection: nextLanguage,
      } }).catch((error) => console.error('Could not synchronize chart language', error));
    }
  };

  const toggleFullScreen = () => {
    toggleFullscreenSafe();
  };

  const isLinkingEnabled = metaScalpSettings?.enabled ?? true;
  const linkingBadge = metaScalpSettings?.binding ? `MS:${metaScalpSettings.binding}` : 'MS:001';
  return (
    <header className="app-header min-w-0 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-md sticky top-0 z-30" data-page={activePage}>
      <div className="max-w-[1720px] mx-auto px-2.5 sm:px-4 lg:px-6 py-1.5 sm:py-2">
        <div className="flex min-w-0 flex-wrap items-center justify-center gap-2 sm:gap-3 xl:justify-between xl:gap-2">
          <div className="flex w-full min-w-0 flex-col items-center gap-2 sm:gap-3 xl:w-auto xl:shrink-0 xl:flex-row xl:gap-2">
            {/* Symmetric grid keeps the logo at the exact center of the header
                on small screens; wide screens use a compact inline brand group. */}
            <div data-header-brand-row className="grid min-h-9 w-full min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-1.5 sm:min-h-10 sm:gap-x-2 xl:flex xl:w-auto xl:shrink-0">
              <span aria-hidden="true" className="xl:hidden" />
              <button
                type="button"
                onClick={() => onPageChange('screener')}
                className="flex shrink-0 items-center justify-center cursor-pointer select-none bg-transparent border-0 p-0 focus:outline-none"
                title="Головна сторінка: Скрінер"
              >
                <img
                  src="/h00k-robot-logo.svg"
                  alt="h00k"
                  width={100}
                  height={48}
                  className="block h-7 w-auto max-w-none shrink-0 sm:h-8"
                />
              </button>

              {/* Fullscreen and language controls stay beside the logo. */}
              <div className="flex min-w-0 shrink-0 items-center justify-start gap-1 sm:gap-1.5">
                <button
                  type="button"
                  onClick={toggleFullScreen}
                  className="rounded border-0 bg-transparent p-1 text-slate-400 transition-colors cursor-pointer hover:text-white"
                  title="На весь екран (Fullscreen)"
                  aria-label="На весь екран"
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                </button>
                <select
                  value={language}
                  onChange={(e) => changeSiteLanguage(e.target.value as SupportedLanguage)}
                  className="min-w-0 cursor-pointer rounded-lg border-0 bg-slate-900 px-1.5 py-1.5 text-xs font-mono font-bold text-slate-200 focus:outline-none sm:px-2"
                  title={t('language')}
                  aria-label={t('language')}
                >
                  <option value="uk">🇺🇦 UA</option>
                  <option value="en">🇬🇧 EN</option>
                  <option value="ru">🇷🇺 RU</option>
                  <option value="pl">🇵🇱 PL</option>
                </select>
              </div>
            </div>

            {/* Navigation Category Tabs */}
            <nav aria-label="Основна навігація" className="grid w-full min-w-0 grid-cols-2 items-center gap-0.5 p-0.5 sm:flex sm:w-auto sm:flex-wrap sm:p-1 xl:shrink-0 xl:flex-nowrap rounded-xl bg-slate-900/90 border border-slate-800 text-xs shadow-inner">
              <button
                id="nav-category-screener-btn"
                aria-current={activePage === 'screener' ? 'page' : undefined}
                onClick={() => onPageChange('screener')}
                className={`flex min-w-0 items-center justify-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg font-semibold whitespace-nowrap transition-all cursor-pointer ${
                  activePage === 'screener'
                    ? 'bg-gradient-to-r from-indigo-600 to-cyan-600 text-white shadow-sm shadow-indigo-900/40'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
              >
                <ScreenerIcon className="w-3.5 h-3.5 shrink-0 text-cyan-400" />
                <span>{t('screener')}</span>
              </button>

              <button
                id="nav-category-patterns-btn"
                aria-current={activePage === 'patterns' ? 'page' : undefined}
                onClick={() => onPageChange('patterns')}
                className={`flex min-w-0 items-center justify-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg font-semibold whitespace-nowrap transition-all cursor-pointer ${
                  activePage === 'patterns'
                    ? 'bg-gradient-to-r from-cyan-600 to-cyan-500 text-white shadow-sm shadow-cyan-900/40'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
                title={!user ? 'Формації та патерни (доступно після реєстрації)' : undefined}
              >
                <FormationsIcon className="w-3.5 h-3.5 shrink-0" />
                <span>{t('patterns')}</span>
                {!user ? (
                  <Lock className="w-3 h-3 text-slate-500" />
                ) : formationsCount > 0 ? (
                  <span
                    className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono ${
                      activePage === 'patterns'
                        ? 'bg-cyan-950/70 text-cyan-200'
                        : 'bg-slate-800 text-slate-300'
                    }`}
                  >
                    {formationsCount}
                  </span>
                ) : null}
              </button>

              <button
                id="nav-category-replay-btn"
                aria-current={activePage === 'replay' ? 'page' : undefined}
                onClick={() => onPageChange('replay')}
                className={`flex min-w-0 items-center justify-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg font-semibold whitespace-nowrap transition-all cursor-pointer ${
                  activePage === 'replay'
                    ? 'bg-gradient-to-r from-amber-500 to-orange-500 text-slate-950 shadow-sm shadow-amber-900/40 font-bold'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
                title="Market Replay: симулятор ринку та відтворення історії свічка за свічкою"
              >
                <History className={`w-3.5 h-3.5 ${activePage === 'replay' ? 'text-slate-950 stroke-[2.5]' : 'text-amber-400'}`} />
                <span>Replay</span>
                <span className={`px-1 py-0.2 rounded text-[9px] font-mono font-extrabold ${
                  activePage === 'replay' ? 'bg-amber-950/30 text-amber-950' : 'bg-amber-500/20 text-amber-300'
                }`}>
                  SIM
                </span>
              </button>

              <button
                id="nav-category-terminal-btn"
                aria-current={activePage === 'terminal' ? 'page' : undefined}
                onClick={() => onPageChange('terminal')}
                className={`flex min-w-0 items-center justify-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg font-semibold whitespace-nowrap transition-all cursor-pointer ${
                  activePage === 'terminal'
                    ? 'bg-gradient-to-r from-emerald-600 to-teal-500 text-white shadow-sm shadow-emerald-900/40'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
                title={!user ? 'Торговий термінал (доступно після реєстрації)' : 'Термінал'}
              >
                <TerminalIcon className="w-4 h-4 shrink-0" />
                <span>{t('terminal')}</span>
                {!user && <Lock className="w-3 h-3 text-slate-500" />}
              </button>
            </nav>
          </div>



          {/* Quick Stats Bar */}
          <div className="hidden xl:flex shrink-0 items-center gap-2.5 sm:gap-4 px-3 py-1.5 rounded-xl bg-slate-900/90 border border-slate-800 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-slate-400">Формацій:</span>
              <span className="font-bold text-white font-mono bg-slate-800 px-1.5 py-0.5 rounded">
                {formationsCount}
              </span>
            </div>
            <div className="h-3.5 w-px bg-slate-800" />
            <div className="flex items-center gap-2">
              <span className="text-emerald-400 font-semibold">▲ {bullishCount}</span>
              <span className="text-slate-600">/</span>
              <span className="text-rose-400 font-semibold">▼ {bearishCount}</span>
            </div>
          </div>
          <div className="flex w-full min-w-0 flex-wrap items-center justify-center gap-1.5 sm:gap-2 xl:w-auto xl:flex-nowrap xl:gap-1.5 [&>button]:shrink-0">
            <button
              id="refresh-screener-btn"
              onClick={onRefresh}
              disabled={isLoading}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all shadow-sm ${
                isLoading
                  ? 'bg-slate-800 text-slate-400 cursor-not-allowed'
                  : 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-cyan-900/30'
              }`}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
             
            </button>

            <button
              id="toggle-sound-btn"
              onClick={onToggleSound}
              title={soundEnabled ? 'Звук сповіщень увімкнено' : 'Звук сповіщень вимкнено'}
              className={`p-1.5 sm:p-2 rounded-lg text-xs border transition-colors ${
                soundEnabled
                  ? 'bg-slate-900 border-slate-700 text-cyan-400 hover:bg-slate-800'
                  : 'bg-slate-900/50 border-slate-800 text-slate-500 hover:text-slate-400'
              }`}
            >
              {soundEnabled ? <Bell className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> : <BellOff className="w-3.5 h-3.5 sm:w-4 sm:h-4" />}
            </button>

            <button
              id="open-telegram-btn"
              onClick={onOpenTelegramAlerts}
              className="flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 rounded-lg text-xs bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/40 text-sky-300 transition-all shadow-sm cursor-pointer relative"
              title={!user ? 'Сповіщення ціни в Telegram (тільки для зареєстрованих)' : 'Сповіщення ціни в Telegram'}
            >
              <Send className="w-3.5 h-3.5 text-sky-400" />
              {!user ? (
                <Lock className="w-2.5 h-2.5 text-sky-400/80" />
              ) : telegramAlertsCount > 0 ? (
                <span className="min-w-[16px] h-4 px-1 rounded-full bg-sky-500 text-slate-950 font-bold text-[10px] flex items-center justify-center">
                  {telegramAlertsCount}
                </span>
              ) : null}
            </button>

            <button
              id="open-surveillance-btn"
              onClick={() => onPageChange('surveillance')}
              className={`flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 rounded-lg text-xs border transition-all shadow-sm cursor-pointer relative ${
                activePage === 'surveillance'
                  ? 'bg-gradient-to-r from-violet-600 to-indigo-600 border-violet-500 text-white shadow-violet-900/30'
                  : 'bg-violet-500/15 hover:bg-violet-500/25 border-violet-500/40 text-violet-300'
              }`}
              title={!user ? 'Системний нагляд (тільки для зареєстрованих)' : 'Стеження за Монетою (Системний нагляд SignalHook)'}
            >
              <MonitoringMenuIcon
                className="w-3.5 h-3.5 text-violet-300"
                active={activePage === 'surveillance'}
              />
              {!user ? (
                <Lock className="w-2.5 h-2.5 text-violet-400/80" />
              ) : surveillanceCount > 0 ? (
                <span className="min-w-[16px] h-4 px-1 rounded-full bg-violet-500 text-slate-950 font-bold text-[10px] flex items-center justify-center">
                  {surveillanceCount}
                </span>
              ) : null}
            </button>

            <button
              id="open-metascalp-btn"
              onClick={onOpenMetaScalp}
              className={`flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 rounded-lg text-xs border transition-all relative ${
                isLinkingEnabled
                  ? 'bg-amber-500/15 hover:bg-amber-500/25 border-amber-500/40 text-amber-300 shadow-sm'
                  : 'bg-slate-900/60 hover:bg-slate-800 border-slate-800 text-slate-400'
              }`}
              title={!user ? 'Лінковка MetaScalp — доступна після реєстрації' : `Лінковка MetaScalp (Група ${metaScalpSettings?.binding || '001'})`}
            >
              <Zap className={`w-3.5 h-3.5 ${isLinkingEnabled ? 'text-amber-400 fill-amber-400/20' : 'text-slate-500'}`} />
              {!user ? (
                <Lock className="w-2.5 h-2.5 text-amber-400/80" />
              ) : (
                <span className="text-[10px] font-mono font-bold px-1 rounded bg-amber-500/20 text-amber-200 border border-amber-500/30">
                  {linkingBadge}
                </span>
              )}
            </button>

            <button
              id="open-watchlist-btn"
              onClick={onOpenWatchlist}
              className="flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 rounded-lg text-xs bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 transition-colors relative"
              title={!user ? 'Список обраних монет (тільки для зареєстрованих)' : 'Список обраних монет'}
            >
              <Bookmark className="w-3.5 h-3.5 text-amber-400" />
              {!user ? (
                <Lock className="w-2.5 h-2.5 text-amber-400/80" />
              ) : watchlistCount > 0 ? (
                <span className="w-4 h-4 rounded-full bg-amber-500 text-slate-950 font-bold text-[10px] flex items-center justify-center">
                  {watchlistCount}
                </span>
              ) : null}
            </button>

            <button
              id="open-archive-btn"
              onClick={onOpenArchive}
              className="flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 rounded-lg text-xs bg-purple-500/15 hover:bg-purple-500/25 border border-purple-500/40 text-purple-300 transition-all shadow-sm cursor-pointer relative"
              title={!user ? 'Архів збережених формацій (тільки для зареєстрованих)' : 'Архів збережених формацій та графіків'}
            >
              <FormationArchiveIcon className="w-3.5 h-3.5 text-purple-400" />
              {!user ? (
                <Lock className="w-2.5 h-2.5 text-purple-400/80" />
              ) : archiveCount > 0 ? (
                <span className="min-w-[16px] h-4 px-1 rounded-full bg-purple-500 text-slate-950 font-bold text-[10px] flex items-center justify-center">
                  {archiveCount}
                </span>
              ) : null}
            </button>

            <button
              id="open-guide-btn"
              onClick={onOpenGuide}
              className="flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 rounded-lg text-xs bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 transition-colors"
              title="Довідник формацій"
            >
              <BookOpen className="w-3.5 h-3.5 text-indigo-400" />
            </button>

            {/* Profile / Auth Button */}
            {user ? (
              <button
                id="user-profile-btn"
                onClick={onOpenProfile}
                className="flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 rounded-lg text-xs bg-cyan-950/40 hover:bg-cyan-900/50 border border-cyan-500/30 text-cyan-200 transition-colors cursor-pointer"
                title="Особистий профіль та налаштування"
              >
                <div className="w-4 h-4 rounded-full bg-cyan-500/30 text-cyan-300 font-bold text-[9px] flex items-center justify-center border border-cyan-400/40">
                  {(profile?.displayName || user.email || 'U')[0].toUpperCase()}
                </div>
                <span className="hidden sm:inline font-medium max-w-[90px] truncate">
                  {profile?.displayName || user.email?.split('@')[0]}
                </span>
              </button>
            ) : (
              <>
              <a href="/welcome" className="hidden sm:inline-flex items-center rounded-lg px-2 py-1.5 text-[11px] font-semibold text-cyan-300 hover:text-white" title="Огляд можливостей h00k">Можливості</a>
              <button
                id="auth-login-btn"
                onClick={onOpenAuth}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs bg-emerald-950/40 hover:bg-emerald-900/50 border border-emerald-500/40 text-emerald-300 transition-colors cursor-pointer font-medium"
                title="Увійти або створити профіль"
              >
                <UserPlus className="w-3.5 h-3.5 text-emerald-400" />
                <span className="hidden xs:inline">Увійти</span>
              </button>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};
