# Side panel UI redesign: minimal, cohesive, monochrome

Decided with Shahin on 2026-10-07:

- Direction: neutral monochrome. Grayscale surfaces, 1px hairlines, one accent (the
  foreground color) for the primary action only, compact UI text, follows system
  light/dark.
- Header: three controls plus an overflow menu. Nothing is removed, only moved.
- Scope: shell (header, dialogs, settings, sessions, prompts, toasts), chat surface
  (messages, tool calls, composer, model picker), onboarding.
- Dialogs: full-height sheets that fill the panel; Settings is a list of sections you
  drill into.

The panel is about 400px wide. Every screen is verified at 400x860 in light and dark.

## Where the styling lives

- Tokens: mini-lit `styles/themes/default.css` (`:root` light, `.dark` dark), mapped to
  Tailwind in `styles/base.css` (`bg-background`, `text-muted-foreground`, ...). Dark mode
  is the `.dark` class on `<html>` (theme-loader.js, mini-lit ThemeToggle).
- Dialog frame: mini-lit `Dialog.ts:62-85` is the single choke point (DialogBase and
  pi-web-ui's SettingsDialog both call it). Width and height are inline styles.
- Chat surface: pi-web-ui `AgentInterface.ts`, `MessageEditor.ts`, `Messages.ts`,
  `ThinkingBlock.ts`, `tools/renderer-registry.ts`; sitegeist registers its own renderers
  in `src/tools/*` and `src/messages/*`.
- mini-lit is consumed from `dist/`, so mini-lit changes need `npm run build` there and a
  patch file like the pi-mono one.

## Phase 1: tokens and color discipline

Symptom: ghost-button hover turns text blue (light) or amber (dark) because
`--accent-foreground` is colored (`default.css:18,69`); about 15 files hardcode green,
orange, red, blue.

- `src/app.css`: override the color tokens after the mini-lit import (later rule wins, no
  mini-lit edit). Neutral `--accent`/`--accent-foreground`, grayscale `--chart-*`,
  `--sidebar-*`; keep a single muted red `--destructive` for destructive text only.
- Body text 14px (UI chrome uses `text-xs`/`text-sm`), drop the 0.3s color transition on
  every element (hover feedback lags) in favor of 120ms on interactive elements.
- Replace hardcoded colors with tokens: `Toast.ts:46-55`, `TabPill.ts:44`,
  `AboutTab.ts:72-93`, `ApiKeysOAuthTab.ts:117`, `BridgeTab.ts:130`,
  `SessionListDialog.ts:461,491`, `SessionCostDialog.ts:139-154,339-344`,
  `CostsTab.ts:169-176,248-253`, `skill.ts:615,641,761`, `sidepanel.ts:934`,
  `app.css:116-162` (orange tutorial pills and user bubble), pi-web-ui
  `renderer-registry.ts:51,112` (green tool check), `ModelSelector.ts:395`.
- Destructive actions become outline/ghost buttons with destructive text, not filled red.

Verify: every screen captured before (scratchpad `ui-before/`) re-shot; no hue left
except the destructive text and in-page overlays (not part of the panel).

## Phase 2: sheets

Symptom: dialogs are floating cards with margins and shadows inside a 400px panel;
Settings (min(1000px, 90vw) x min(800px, 90vh)) wastes the edges.

- mini-lit `Dialog.ts`: below 640px viewport width render the content box edge to edge
  (`inset-0`, no radius, no shadow, no backdrop blur), with a sticky header row: title on
  the left, close on the right. Wider viewports keep the centered card. Shipped as
  `patches/mini-lit-v0.2.1-sitegeist.patch`, applied by `scripts/setup-siblings.sh`.
- Remove per-dialog fixed sizes that fight the sheet (`RecordSkillDialog` 820x860,
  `SessionCostDialog` 1200, `SkillDialog` 800, `CustomProviderEditDialog` 720x760).

Verify: open every dialog listed in the audit at 400x860; nothing scrolls sideways.

## Phase 3: settings as a drill-in list

Symptom: seven tabs in a horizontal strip at 400px; "API Keys & OAuth" wraps to four
lines, later tabs scroll the whole dialog sideways and clip it.

- New `src/dialogs/SettingsSheet.ts` built on the existing `SettingsTab` interface
  (`getTabName()` + `render()`): a list of sections (Providers, Custom providers, Skills,
  Bridge, Costs, Proxy, About); choosing one shows it with a back arrow. Replaces the two
  `SettingsDialog.open([...])` call sites (`sidepanel.ts:370-379`, `951-959`).
- Short section names; refresh stale copy (Bridge tab still says `npx sitegeist mcp`).

Verify: each section at 400px, keyboard (Tab, Enter, Esc/back).

## Phase 4: header and overflow menu

Symptom: seven icon buttons, one unlabeled (`<theme-toggle>`), crowding the title.

- Header: Sessions, editable title, New, overflow (three controls plus the menu button).
- New `src/components/OverflowMenu.ts` (mini-lit has no menu): anchored popover, closes
  on outside click and Esc, arrow-key navigation, `role="menu"`. Items: Share this tab,
  Record skill / Stop recording, Download chat, Theme (Light / Dark / System), Settings.
- While recording, a small "Recording, Stop" control appears in the header so the state
  stays visible.

Verify: menu open/close by mouse and keyboard; every action still works.

## Phase 5: chat surface (pi-web-ui patch)

- Composer (`MessageEditor.ts:387-539`): hairline border, no shadow, tighter padding;
  send button is the one filled (foreground) control when enabled; model button reads as
  plain text with a chevron.
- Messages: user message is a neutral `bg-secondary` block (replaces the orange
  `.user-message-container`), assistant text full width; tool calls (`Messages.ts:272`)
  become compact one-line rows with a hairline and a status glyph instead of cards with
  shadows; thinking block and usage line in `text-muted-foreground`.
- Sitegeist renderers (`navigate.ts`, `skill.ts`, `repl.ts`, `extract-image.ts`,
  `debugger.ts`, `ask-user-which-element.ts`) follow the same row shape.

Verify: a local mock OpenAI-compatible provider (custom provider in settings) streams a
canned conversation with thinking, text and tool calls so the chat can be screenshotted
without a real account.

## Phase 6: onboarding

Symptom: `WelcomeSetupDialog.close()` resolves on any close, so Esc or the X still
throws the user into Settings (`sidepanel.ts:1240-1254`).

- First run shows an inline empty state in the panel (one line of copy, a "Connect a
  provider" button that opens the Providers section) instead of a modal followed by
  Settings. Closing anything never forces Settings.
- `WelcomeMessage`: smaller title, grayscale orb, neutral suggestion pills.

Verify: fresh profile (no keys), dismiss paths, provider connected path.

## Delivery

One commit per phase on a branch, PR into the private repo, signed release
(`scripts/release-crx.sh m3`), which now updates running browsers immediately.
