'use strict';
const { normalizeFloatingBoundsMap } = require('./workspace.cjs');

// One independently persisted workspace for each external terminal.
const PROVIDERS = Object.freeze(['metascalp', 'tiger', 'vataga']);
const MODES = Object.freeze(['full', 'blocks', 'floating']);
const SIDES = Object.freeze(['right', 'left', 'top', 'bottom']);
const PANELS = Object.freeze([
  { id: 'screener', name: 'Скрінер', hash: 'screener' },
  { id: 'formations', name: 'Формації W/M', hash: 'patterns' },
  { id: 'early', name: 'Раннє виявлення', hash: 'patterns' },
  { id: 'terminal', name: 'Термінал HookChart', hash: 'terminal' },
  { id: 'surveillance', name: 'Спостереження', hash: 'surveillance' },
  { id: 'replay', name: 'Тестування на ринку', hash: 'replay' },
]);
function defaults(provider) {
  return {
    enabled: provider === 'metascalp',
    autoAttach: true,
    follow: true,
    alwaysOnTop: false,
    mode: 'full',
    side: 'right',
    width: 440,
    height: 360,
    widgets: ['screener', 'formations'],
    targetHint: null,
    // Saved manually arranged floating panes; sanitized per panel on load.
    floatingBounds: {},
  };
}
function clampNumber(value, fallback, min, max) {
  return Number.isFinite(Number(value))
    ? Math.max(min, Math.min(max, Math.round(Number(value))))
    : fallback;
}
function normalizeProfile(provider, input) {
  const base = defaults(provider);
  const raw = input && typeof input === 'object' ? input : {};
  const widgets = Array.isArray(raw.widgets)
    ? [...new Set(raw.widgets.filter(id => PANELS.some(panel => panel.id === id)))]
    : base.widgets;
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled,
    autoAttach: typeof raw.autoAttach === 'boolean' ? raw.autoAttach : base.autoAttach,
    follow: typeof raw.follow === 'boolean' ? raw.follow : base.follow,
    alwaysOnTop: raw.alwaysOnTop === true,
    mode: MODES.includes(raw.mode) ? raw.mode : base.mode,
    side: SIDES.includes(raw.side) ? raw.side : base.side,
    width: clampNumber(raw.width, base.width, 240, 1100),
    height: clampNumber(raw.height, base.height, 200, 1000),
    widgets: widgets.length ? widgets : [...base.widgets],
    floatingBounds: normalizeFloatingBoundsMap(raw.floatingBounds, PANELS.map(panel => panel.id)),
    targetHint: raw.targetHint && typeof raw.targetHint.exe === 'string'
      ? { exe: raw.targetHint.exe.slice(0, 100), title: String(raw.targetHint.title || '').slice(0, 160) }
      : null,
  };
}
function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const profiles = {};
  for (const provider of PROVIDERS) profiles[provider] = normalizeProfile(provider, src.profiles?.[provider]);
  return { version: 1, profiles };
}
function matchesTerminal(provider, item) {
  const exe = String(item.exe || '').toLowerCase();
  // Match executable rather than window title: unrelated windows can spoof a title.
  return {
    metascalp: /meta.?scalp/.test(exe),
    tiger: /^tiger(?:[.\-_]|$)/.test(exe) || /tiger.?trade/.test(exe),
    vataga: /vataga/.test(exe),
  }[provider] === true;
}
function availablePanels(profile) {
  if (profile.mode === 'full') return ['full'];
  return profile.widgets.filter(id => PANELS.some(panel => panel.id === id));
}
module.exports = { PROVIDERS, MODES, SIDES, PANELS, defaults, normalizeProfile, normalizeSettings, matchesTerminal, availablePanels };
