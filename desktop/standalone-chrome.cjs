'use strict';

// Native window controls belong to Electron. The h00k.top page stays sandboxed.
const WINDOW_BUTTONS_WIDTH = 138;
const LOCAL_GEAR_SLOT = 48;
const HEADER_SAFE_WIDTH = WINDOW_BUTTONS_WIDTH + LOCAL_GEAR_SLOT + 12;

function standaloneWindowChrome(platform) {
  if (platform !== 'win32') return {};
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#020617',
      symbolColor: '#b7e8f6',
      height: 38,
    },
  };
}
function standaloneToolbarInset(platform) {
  return platform === 'win32' ? WINDOW_BUTTONS_WIDTH : 0;
}
function standaloneHeaderCSS() {
  // Reserve native controls + the isolated docking gear on wide windows.
  // On narrow windows a dedicated 48px top row prevents navigation collisions.
  return `
    .app-header { -webkit-app-region: drag; }
    .app-header :is(a, button, input, select, textarea, nav, label,
      [role="button"], [role="menu"], [role="menuitem"], [tabindex]) {
      -webkit-app-region: no-drag !important;
    }
    @media (min-width: 701px) {
      .app-header > div:first-child { padding-right: ${HEADER_SAFE_WIDTH}px !important; }
    }
    @media (max-width: 700px) {
      .app-header > div:first-child {
        padding-top: 48px !important;
        padding-right: 10px !important;
      }
    }
  `;
}
module.exports = {
  WINDOW_BUTTONS_WIDTH, HEADER_SAFE_WIDTH,
  standaloneWindowChrome, standaloneToolbarInset, standaloneHeaderCSS,
};
