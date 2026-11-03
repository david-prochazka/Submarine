# Screenshots for the project README

The README's hero image and its Screenshots table use these files. Keep the
names when you replace one, and the README picks it up.

Size: 1600 × 1000 PNG (a 1280 × 800 window at 1.25×), dark appearance, the
app window only.

| File | Shot |
|---|---|
| `hero.png` | A terminal session with Files docked beside it (Local above Remote). |
| `servers.png` | A folder in Servers: a sub-folder tile and server cards, one connected. |
| `palette.png` | The command palette with a short query matching a few servers. |
| `tunnels.png` | The Tunnels tool with a local, a remote and a dynamic forward running. |
| `mirror.png` | The Mirror tool with the New mirror form filled in above a watching mirror. |
| `commands.png` | The Commands tool with commands for this server and for all servers. |
| `logins.png` | Logins with an SSH key selected (fingerprint, public key, used by). |
| `monitoring.png` | Monitor at 15 min with alert, warning, healthy and paused servers. |
| `server-edit.png` | The server editor on Port forwarding. |

They were taken in the browser build (`npm run dev`) with a mocked Tauri
backend serving sample servers, files, forwards and monitor samples, so no
real hosts or credentials appear. The browser build leaves the macOS traffic
lights to the system, so they were drawn over the top-left corner to match the
app.
