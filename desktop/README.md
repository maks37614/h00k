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
