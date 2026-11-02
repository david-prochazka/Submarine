# Submarine redesign plan

Source design: [Submarine redesign canvas](https://claude.ai/artifact/EKL4GrjfpEXg2S5yoHcPXi). It has 9 screens, each in dark and light, plus a token sheet.

Branch: `DP-redesign` (worktree `~/projects/Submarine-redesign`), from `main`.

Approach: phased. Each phase is one or more commits on `DP-redesign`, checked in light and dark and at phone width before moving on.

## Phase 1: Foundation ✅ done (`a0ec562`)

- [x] Design tokens in `src/App.css` (`:root` dark, `:root[data-theme="light"]`): surfaces, ink, muted/subtle, primary, status colours, borders, scrim, shadows
- [x] Tailwind palette remap (`tailwind.config.js`): `zinc`/`white`/`black` and the status hues resolve through CSS variables, mirrored in light mode, so existing classes theme themselves
- [x] Codemod: hard-coded hex backgrounds → `surface` / `panel` / `elevated`, scrims → `bg-scrim`, white-on-colour → `snow`
- [x] Appearance setting (System / Light / Dark) in `src/util/appearance.ts`; replaces the Background Theme swatches. Teal theme accent; the old default `#60a5fa` migrates to it
- [x] UI font (system / Inter, 13px) and mono (SF Mono / JetBrains Mono); neutral scrollbars
- [x] Labelled sidebar: All servers + folder tree with counts, Tools (Logins, Library, Monitor, Wall), profile footer with Lock and Settings; collapses to an icon rail
- [x] Title bar beside the sidebar; Safari-style session tabs; broadcast-target outline
- [x] Session toolbar (terminal tabs, SFTP / Ports / Library / Info) in the quieter tool-bar style
- [x] Mobile bottom dock restyled with labels

## Phase 2: Servers home (artboards 1, 1b)

- [x] Header: back/forward (⌘[ ⌘]), breadcrumb (Servers › Clients, steps take drops), Grid/List segmented control, New folder, New server, Quick connect (primary; becomes the palette's Connect in Phase 6)
- [x] Page title with live summary ("6 servers, 3 connected, 1 connecting"), filter field, sort menu (your order / name / last connected; dragging only in your order)
- [x] Server cards: icon tile in the server's colour, name, `user@host:port` in mono, status pill from the open session, chips (protocol, jump host, tunnels, opens at start), "Last connected…" (per device, `util/lastConnected.ts`) swapped for Connect / Edit / More (Duplicate, Delete) on hover or focus. No OS or named tags: the app doesn't store them. No Files button yet: it needs a way to open a session on its Files tool (Phase 3)
- [x] List layout (table; narrow widths drop columns)
- [x] Folders as compact tiles above the servers (open, drop into, rename, delete)
- [ ] Favorites section in the sidebar (needs a favourite flag on servers, synced) and servers with status dots under their folders in the sidebar
- [x] Empty state: New server, Quick connect, import from `~/.ssh/config` (host count shown, highlighted when it has hosts) / PuTTY / MobaXterm / JSON (file picker, parsed straight into the import dialog)
- [ ] The window title bar still sits above the page header; merging the two waits for Phase 3 (the tabs live there)

## Phase 3: Terminal session (artboard 2)

- [ ] Tool bar with first-class Terminal, Files, Tunnels, Mirror, Docker, Info, Commands, Notes (⌘1–⌘8)
- [ ] Inspector: dock any tool on the right (⌘\)
- [ ] Split (⌘D) and Broadcast (⌘⇧B) with the amber banner and tab outlines
- [ ] Terminal colour scheme that follows light mode (default scheme only; user-picked schemes stay)

## Phase 4: Files (artboard 3)

- [ ] Local and Remote side by side, each with a path bar
- [ ] Drag ghost and highlighted drop row
- [ ] Transfer queue drawer that explains failures and offers a fix

## Phase 5: Server editor (artboard 4)

- [ ] Sheet with seven grouped sections instead of the long slide-over
- [ ] Inline live validation; issues shown on the section list
- [ ] Test connection: DNS, port and host key before saving

## Phase 6: Command palette (artboard 5)

- [ ] ⌘K fuzzy search across servers, actions, folders and saved commands
- [ ] ↑ ↓ / Enter navigation; every action shows its shortcut
- [ ] Sidebar "Search or run…" field opens it

## Phase 7: Monitor (artboard 6)

- [ ] Cards sorted by severity, sparklines for CPU, memory, network
- [ ] Alerts with a direct Open terminal action
- [ ] Alert count badge on Monitor in the sidebar

## Phase 8: Logins vault (artboard 7)

- [ ] Keys and passwords in one list with type and usage
- [ ] Detail: fingerprint, public key, which servers use it (shown before deleting)
- [ ] Generate key popover

## Phase 9: Unlock (artboard 8)

- [ ] Single focused screen: quick unlock (Touch ID / Windows Hello where supported) or master password, profile name, Switch profile
- [ ] Note on what auto-lock does; sonar rings
- [ ] Sidebar Lock returns here (⌘L)

## Phase 10: Sweep

- [ ] Remaining panels not in the design (Settings, Cloud, Docker, Tunnels, Mirrors, RDP/VNC, dialogs): spacing, type sizes, uppercase labels → sentence case, remove glow shadows
- [ ] Keyboard shortcuts from the design wired up (⌘K, ⌘N, ⌘L, ⌘,, ⌃⌘S, ⌥⌘A)
- [ ] Accessibility pass (focus rings, labels, contrast in both themes)
- [ ] Screenshots in `docs/screenshots/` and README refreshed

## Notes

- Verify each phase in the browser with the mocked Tauri backend, then in `npm run tauri dev`.
- New features (palette, editor sheet, Touch ID unlock, import detection, favourites) may need backend commands. Check `src-tauri` before building UI for them.
