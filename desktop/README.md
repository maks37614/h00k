# h00k Desktop — Smart Dock (Windows MVP)

This is a separate Electron application for the existing https://h00k.top website.
It does not execute exchange scanners on the user's computer or change VPS deployment.

## Current capabilities

- User-selectable MetaScalp, Tiger.Trade, and Vataga, each with an independent persisted profile.
- Several terminals can be enabled at once.
- Full h00k website, selected h00k page panels, or independent floating windows.
- Attach left, right, top, or bottom **outside** the selected terminal's top-level window.
- Gapless seam: zero dock-to-terminal spacing and Win32 DWM visible-frame bounds
  eliminate invisible resize-border gaps; docked h00k panels are frameless and shadowless.
- A persistent ⚙ gear on every attached h00k panel opens a secure native quick menu
  (position, mode, full settings, detach); Ctrl+, also opens the settings for that terminal.
- Faster ~160ms native window position updates while preserving the terminal's order controls.
- Follow terminal movement and resizing, hide docked views when it is minimized.
- Manual OS window selector if a terminal executable has an unexpected name.
- Per-terminal dock size, automatic attach, follow and always-on-top settings.
- A shared h00k web login session. Smart Dock never asks for exchange API keys.
- An independent full h00k browser window accessible from the settings window.

**Scope:** The selectable panels are real h00k pages: Screener, Formations, Early W/M,
HookChart Terminal, Surveillance and Replay. Individual OI, liquidations, quality-score
and density micro-widgets are not yet isolated as independent components. An
actual native child window embedded *inside* the terminal is not implemented:
these are independent Windows top-level windows arranged by Smart Dock.

**Vataga:** Vataga docking uses Win32 window detection or manual selection.
Vataga's third-party screener integration is publicly documented but its
command protocol is not. Ticker-linking is intentionally not claimed or attempted
until a verified API specification is available. The existing website MetaScalp
and Tiger local integrations are kept untouched.

## Build on a Windows 10/11 (64-bit) developer machine

~~~powershell
cd desktop
npm install
npm test
npm start
~~~

Build a Windows NSIS installer:

~~~powershell
cd desktop
npm install
npm run dist
~~~

Installer output is in desktop/dist/. GitHub Actions includes a separate
"h00k Desktop Windows" workflow with a manual dispatch trigger and
artifact upload on successful builds. It does not deploy to h00k's VPS.

## Windows and security constraints

The native discovery agent is a single persistent PowerShell process reading
visible top-level window metadata via Win32 EnumWindows and GetWindowRect.
It never injects code, touches the keyboard/mouse, accesses positions, or sends
trades. Window coordinates are converted to Electron logical DPI coordinates.

The h00k remote website is isolated with sandbox, contextIsolation and no
Node integration/preload. Only the local settings page exposes a narrow,
sender-checked IPC bridge.

If the trading terminal is maximized and no space exists beyond the selected
edge, docked views are hidden instead of overlapping the trading controls.
For a maximized terminal use a second monitor, a smaller terminal window,
or manually positioned floating panes.

## Manual acceptance tests still required

Verify on real Windows 10/11, multiple monitors, 100/125/150% DPI,
moving/resizing/minimizing each supported terminal, elevated/UAC terminals,
fullscreen and reconnect behavior, and website login persistence.
MetaScalp and Tiger localhost ticker routing must be validated separately.
Passing Node unit tests is not a substitute for end-to-end Windows tests.

The h00k website query desktopPanel changes presentation only. It does not
grant access to locked sections or expose desktop IPC.

## v0.1.1 quick control and seam verification

The gear is an isolated local WebContentsView with a minimal IPC preload. The
remote h00k.top website cannot invoke toolbar commands. Settings opened from
the gear automatically select the correct provider, including after the settings
window was closed. Switching from docked to floating recreates a decorated
movable window; switching back recreates a frameless dock panel.

Verify that the target edge and h00k panel physically meet at 100%, 125%, and
150% Windows scaling and on a mixed-DPI second monitor. Windows DWM visible
bounds are used when available, while GetWindowRect remains a fallback.
A screenshot alone cannot guarantee every OS decoration/theme is pixel-perfect.

For an already-installed copy, use a new Windows installer from this branch's
successful **h00k Desktop Windows** Actions artifact. Desktop files are not
replaced by updating the Linux VPS.

## v0.1.2 audit fixes

- Saved per-panel floating bounds are validated, retained independently for
  MetaScalp/Tiger/Vataga, and restored when their original monitor is connected.
  An unplugged/off-screen display falls back to a visible work area.
- Explicit changes to floating mode, side or dimensions reposition existing
  windows even if Follow is disabled. New users can choose the initial side
  without needing a running trading terminal.
- Web pages are lazy-loaded **only after** the window has sufficient display
  space and is first displayed. A docked panel hidden for over 30 seconds due
  to a missing/minimized terminal or no free space is destroyed, releasing
  timers/network activity until the terminal returns. The website server itself
  continues handling its ordinary traffic.
- "Автоматично знайти" now clears the manually stored target. A chosen
  executable is found again if its window title changes and there is exactly
  one matching running window.
- The local window picker no longer re-creates its options on every tracker
  tick (especially when PnL/price titles update).

**Authentication limitation:** This version embeds h00k.top in Electron.
Email/password sign-in remains the practical option in the embedded view.
Google OAuth through embedded webviews is not guaranteed (Google restricts
embedded user-agents); this version does not claim to solve external-browser
OAuth callback/session transfer. Do not enter exchange API keys in Smart Dock.

**Vataga limitation:** Public integration instructions exist (enable application
integration in Settings > General > Other, and select orderbook > Bind to
window > Screener), but the command protocol used by partners is not published.
No unverified API traffic is sent. References:
https://liner.scalpsecta.com/docs
https://vataga.trading/ru/news/releases/obnovlenie-terminala-vataga-terminal-5-13-3

These audit changes need real Windows validation (multi-monitor DPI, actual
trading terminal executables, drag/resize behavior, Google auth experience).

## v0.1.3: branded Windows installer

- The Windows executable, taskbar and its desktop shortcut use a **multi-resolution
  h00k robot-eyes icon** (16 through 256 px) instead of the Electron placeholder.
  The graphic is generated from the original existing `public/h00k-robot-logo.svg`
  with no external image files.
- The assisted NSIS install/uninstall wizard includes dark-navy h00k-themed
  sidebar illustrations and a cyan-on-dark header (true 24-bit BMP graphics);
  standard Windows wizard controls retain the native Windows theme.
- The setup wizard now offers a **real "Створити ярлик h00k на робочому столі"
  checkbox**. It defaults to checked; uncheck it to omit the shortcut. The
  Start menu shortcut remains available. During re-installation the explicit
  unchecked choice also clears an old desktop link.
- `desktop/build/installer.nsh` extends the existing electron-builder NSIS
  script rather than replacing the install/uninstall implementation.
- Branding assets are generated locally during `npm test` and `npm run dist`
  via `npm run brand-assets`. They are intentionally ignored by Git because
  the robot source SVG remains the single source of truth.
- New tests verify the robot ICO structure, its multi-resolution PNG frames,
  24-bit bitmap dimensions, and the optional shortcut script.

Run on Windows:
```powershell
cd desktop
npm install
npm test
npm run dist
```
Download the installer from the **h00k Desktop Windows** GitHub Actions
artifact. No Linux VPS deployment is needed. If you previously pinned the
old Electron icon on the Windows taskbar, unpin it and pin the newly installed
h00k Desktop again to refresh the taskbar cache.
