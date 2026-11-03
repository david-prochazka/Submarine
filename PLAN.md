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

## Phase 3: Terminal session (artboard 2) ✅ done

- [x] Tool bar with first-class Terminal, Files, Tunnels, Mirror, Docker, Info, Commands, Notes (⌘1–⌘8; Ctrl+Shift+1–8 off the Mac, where Ctrl belongs to the shell). A tool takes the terminal's place; Docker left Info, Mirror left Files' header, Commands and Notes split the old Library panel (Notes = this server's notes + saved notes). New terminal (+) moved to the tool bar; terminal tabs show in a second row once there are two
- [x] Inspector: ⌥-click a tool (or its header's dock button) to dock it beside the terminal, ⌘\ toggles; switch the docked tool from its header. The old "full screen" toggle is gone (a tool view is that now); the position menu (right / left / above / below) moved into the inspector header. Hidden on phones
- [x] Split (⌘D): split with a new terminal of this server, or leave the split. Cross-server tiling stays in the session tab's context menu
- [x] Broadcast (⌘⇧B, Ctrl+Shift+B): starts with every open session when fewer than two are picked; amber banner with the target chips and Stop; tab outlines from Phase 1
- [x] Terminal colour scheme that follows light mode (default "Submarine" scheme only; user-picked schemes stay)
- [ ] Session tool header styles inside the tools themselves (Files' Local/Remote tabs, Tunnels, Docker, Info sub-tabs) still uppercase: Phase 4 for Files, Phase 10 for the rest

## Phase 4: Files (artboard 3) ✅ done

- [x] Local and Remote side by side by default (Local above Remote at phone width; the one-at-a-time layout stays a choice). Flat pane header (name, "This Mac" / server name, sudo, Browse, New folder, Refresh, Filter), path bar with Up, chevron crumbs, bookmark and recent folders. Sentence-case columns, 28px rows, sans names, mono permissions. Layout and Compare controls moved into the tool header (their own bar when docked in the inspector)
- [x] Drag ghost (tilted card, count badge, "Upload to releases/"); the folder row under the pointer is outlined with a "Drop to upload 3 items" pill, or the whole list when dropping into the open folder. Marked through attributes, so a mousemove doesn't re-render the panes
- [x] Transfer queue drawer: rows stay until "Clear finished", with speed, time left, destination, and failures in words with a fix (Retry as root for permission denied, Retry for a dropped connection or full disk), plus Show in folder for finished downloads. The backend's transfer events now carry `from`, `to` and `dir` for this. The start and finish toasts are gone; errors still toast
- [x] Context menu and the Files dialogs (rename, new folder, move, properties, archive) restyled: elevated surface, sentence case, primary accents
- [ ] Pause and resume a transfer: needs backend support
- [ ] ⌘⌥T to show or hide the queue: Phase 10 with the other shortcuts

## Phase 5: Server editor (artboard 4) ✅ done

- [x] Sheet (`ServerEditor.tsx`) in place of the slide-over: header with the server's colour, folder and last edit; section list (Connection, Authentication, Organisation, Proxy, Port forwarding, Mirrors, Startup for SSH; Display ("Remote desktop" / "Screen") for RDP and VNC; telnet has the first four); grouped label/control rows; tabs across the top below 768 px, full screen on phones. Esc cancels, ⌘S / Ctrl+S saves
- [x] Inline validation (`util/serverIssues.ts`): name, host, port, saved login or key picked, proxy host and port, forwards (ports, duplicate local ports, a target host:port as the backend wants it), mirror folders. A field shows its issue once left, or all show after Save; counts on the section list; Save jumps to the first one. A forward's target is now host and port fields (the old placeholder suggested a bare "80", which the backend refused)
- [x] Test connection (`probe.rs`, `test_server_connection`): `~/.ssh/config` alias, DNS, port (or through the SOCKS5 / HTTP proxy), then for SSH the host key against known_hosts files and the vault (trusted, new, changed, refused). Stops after key exchange: no login, nothing saved. Through a jump host it tests the jump host and says so. Live "Resolves to …" under Host (`resolve_host`)
- [x] Import dialog split out (`ServerImportDialog.tsx`), sentence case; its Escape no longer reaches the editor
- [x] Shared form rows (`FormRows`, RDP share fields) on the new field, segment and switch styles, which also fixes the dark switch knob in light mode in the RDP and VNC tab panels
- [ ] Not in the app, so not in the sheet: keep-alive, compression, terminal type, agent auth, favourites, working folder, "open with" tools, mirror sync modes
## Phase 6: Command palette (artboard 5) ✅ done

- [x] ⌘K (Ctrl+Shift+K off the Mac, where Ctrl+K belongs to the shell) opens `CommandPalette.tsx`; not over another dialog. Fuzzy match (`util/fuzzy.ts`): substring first, then letters in order, tightest span, word starts count; strewn matches are dropped. Typed, the groups follow their best match
- [x] Servers (open sessions first, then by last connected; status shown): ↩ connect or switch, ⌘↩ edit, ⌥↩ open beside the session in front (cross-server split). Actions: the session's tools (⌘2–⌘8), Split, Toggle inspector, Edit this server, Broadcast, New server, Quick connect, Import from `~/.ssh/config`, the sections, Activity log, appearance, Lock. Folders open in Servers. Saved commands for the server in front (scope respected) run in its active terminal; ⌥↩ types without running
- [x] ↑ ↓, PgUp/PgDn, ⌃N/⌃P on the Mac; the footer names what ↩, ⌘↩ and ⌥↩ do for the selected row; Esc clears, then closes and returns focus. Combobox + listbox with groups for screen readers
- [x] Sidebar "Search or run… ⌘K" field, and a search button on the collapsed rail. SessionView takes a `request` prop (view, split, inspector) for the palette
- [ ] No way to open it on a phone yet (no keyboard, no sidebar): a search button in the mobile title bar or dock
- [ ] Shortcuts the design lists but the app doesn't have yet (⌘N, ⌘E, ⌘L, ⌘⇧M, ⌘⇧L, ⌘T) aren't shown: they show once Phase 10 wires them

## Phase 7: Monitor (artboard 6) ✅ done

- [x] Header with 15 min / 1 hour / 24 hours, Alert rules, settings, Add server; page title with a summary and alert / warning / healthy / paused counts, Pause all or Start all
- [x] Cards sorted by severity (alert, warning, healthy, connecting, paused): colour dot, host, last check, status pill, metrics in two columns with a trend under each (CPU primary, memory info, red or amber when a rule is crossed). Trends break where nothing was measured. History (`util/monitorHistory.ts`) lives in memory from app start: every sample for an hour, minute averages for 24 hours
- [x] Alert rules (`util/monitorRules.ts`, dialog): warning and alert levels per metric (CPU, memory, swap, disk, load) held for N minutes; offline always alerts, a failed check warns. Crossing into alert logs, pops up and plays the sound like an outage. Kept on this device (localStorage)
- [x] Issue strips on the card with Open terminal (opens or switches to the session); card menu: Open terminal, Pause/Start checking, Metrics…, Stop monitoring
- [x] Alert count badge on Monitor in the sidebar, on the collapsed rail and in the phone dock
- [x] Empty state, and the Add, Settings and Metrics dialogs restyled (sentence case, switches, grouped rows)
- [ ] Network stays in bits per second (Mbps), not the design's MB/s: that's what links and plans are sold in
- [ ] No macOS notification (no notification plugin yet), no folder breadcrumb (Monitor › Clients), rules aren't synced: would need backend storage
- [x] Closing a dialog opened from the card menu returns focus to the card's More button (Phase 10)

## Phase 8: Logins vault (artboard 7) ✅ done

- [x] `LoginsVault.tsx`: keys and saved logins in one list (All / SSH keys / Passwords, search, ↑ ↓), each with its type and usage, "Unused" when nothing signs in with it; "Encrypted with your master password" footer. Header breadcrumb Logins › name, New password, Add key (file or paste), Generate key. On phones the list and the detail take turns, with a back button
- [x] Key detail: type, bits and comment, SHA256 fingerprint worked out from the public key (`util/sshKeyInfo.ts`, matches `ssh-keygen -l`), private key and passphrase status, public key with Copy. Saved login detail: username, password with Reveal and Copy, or the key it signs in with
- [x] Used by: servers signing in with the key directly or through a saved login ("through Ops login"), each opens a session; the saved logins that use a key. Delete names the servers and logins first
- [x] Rename (prompt), More: Edit…, Export…, Delete…. Export (`export_ssh_key`) saves the private key (0600) and `<name>.pub` where you choose
- [x] Generate key popover: ED25519, RSA 4096 or ECDSA P-256, name, comment (`generate_ssh_key` takes `kind` and `comment`; RSA runs off the async threads). The new key is selected
- [x] Password and key sheets restyled (fields, sentence case, errors in the sheet instead of the log)
- [ ] Not in the app, so not on the page: created date, password strength and "changed N days ago" (no timestamps stored), passphrase on a generated key (the vault already encrypts it)
- [ ] "Install on a server…" (append the public key to authorized_keys over a session): needs a backend command
- [ ] Confirm and prompt dialogs are still the old uppercase style: Phase 10

## Phase 9: Unlock (artboard 8) ✅ done

- [x] `ProfileSelectPage.tsx` opens on a focused unlock screen for the profile used last: "Submarine is locked", the profile's name, password with a square Unlock button, Switch profile, Caps Lock state (shown once a key or click tells it), the quick unlock button (Windows Hello, or the fingerprint on Android) and an encryption note. Sonar rings behind it and two pulses round the logo (none with reduced motion)
- [x] Switch profile opens the list (local and cloud in one, current one ticked, Back or Esc returns), with New profile, Import and the cloud bar. A cloud-only profile still opens to Get. The create form, import form, row menu, banners and footer restyled on the shared field, button and tile styles, sentence case
- [x] Lock (sidebar, rail, phone dock, palette) returns here; ⌘L (Ctrl+Shift+L off the Mac) locks, not over a dialog. After a lock, Windows Hello waits for a click instead of prompting at once. The confirm says "Lock Submarine?"
- [ ] Touch ID: quick unlock isn't built for macOS or Linux (`quick_unlock.rs`), so there the screen asks for the password only
- [ ] Auto-lock (after N minutes idle or on sleep): the app has none, so the note says what's true instead: AES-256-GCM, password can't be recovered
- [ ] The logo is still the old one: Phase 11

## Phase 10: Sweep (in progress)

- [x] Panels not in the design restyled: confirm, prompt and replace-file dialogs as sheets (`btn-danger` added); Library and Activity pages with the page header; command and note sheets; Settings (grouped cards, design switches, steppers, Reset asks through the app's confirm); Quick connect, Cloud sync, host key and 2FA prompts, history search, held changes; Tunnels, Mirrors, Docker, Info, Commands, Profile and sharing, invites, sync server; Wall toolbar (segmented columns and rows) and the broadcast menu. Every uppercase label is sentence case, no backdrop blur or glow shadows, 9–10.5px text raised to 11–12px, black wells now `field` / `bg-terminal`, badges on `pill`
- [x] Shortcuts from the design: ⌘N new server, ⌘E edit the server in front, ⌘T opens the palette to pick a server, ⌘⇧M Monitor, ⌘⇧L Logins, ⌘, Settings, ⌃⌘S hide the sidebar, ⌥⌘A light or dark. Off the Mac they're Ctrl+Shift+<key> and Ctrl+,; Logins and light or dark have none there (Ctrl+Shift+L locks, Ctrl+Shift+A is the terminal's select all). Shown in the palette and the sidebar tooltips. Not over a dialog, not on phones
- [x] The macOS menu doesn't take the new shortcuts: the app sets no menu, and Tauri 2.12's default one binds only ⌘W, ⌘M, ⌘H, ⌥⌘H, ⌘Q, ⌃⌘F and the edit keys
- [ ] Accessibility pass (focus rings, labels, contrast in both themes). Done so far: Cloud sync's fields have visible labels and autofill hints; a Monitor card's More button gets focus back after its menu, Metrics… or a cancelled Stop monitoring closes
- [ ] Screenshots in `docs/screenshots/` and README refreshed

## Phase 11: Rename to Supermarine

The app is now called Supermarine, with a new logo: "Logo C Porthole (chosen)" on the Logo page of the design canvas (`project/brand/Porthole.dc.html`).

- [ ] Logo: export the Porthole mark to the app icon set (`src-tauri/icons`, `app-logo.png`, `public/`), the sidebar header and the website
- [ ] Name in the UI (sidebar header, window title, About, unlock screen, dialogs) and in `tauri.conf.json` (`productName`, window title). Keep the bundle identifier so installs update in place, or plan the move
- [ ] Storage keys (`submarine-*` in localStorage), the "Submarine" terminal scheme id, and the profile and vault paths: keep reading the old names so nothing is lost
- [ ] README, `llms.txt`, `PRIVACY.md`, `website/`, `packaging/`, store listings; the repository name and download links last

## Notes

- Verify each phase in the browser with the mocked Tauri backend, then in `npm run tauri dev`.
- New features (palette, editor sheet, Touch ID unlock, import detection, favourites) may need backend commands. Check `src-tauri` before building UI for them.
