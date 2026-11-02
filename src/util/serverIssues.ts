// What's wrong with a server as the editor holds it, field by field, so the
// sheet can mark the field and count the issues on its section. The rules
// are the backend's (tunnel.rs parses forwards the same way): an issue here is
// something that would fail on save or on connect.

export type EditorSection = "connection" | "auth" | "org" | "proxy" | "forward" | "mirrors" | "startup" | "display";

export type Issue = { section: EditorSection; field: string; message: string };

const portOk = (s: string) => /^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= 65535;

/** A listen spec: `8080`, `0.0.0.0:8080` or `[::1]:8080`; its port, or null. */
export function bindPort(spec: string): string | null {
  const s = spec.trim();
  if (!s) return null;
  const port = s.includes(":") ? s.slice(s.lastIndexOf(":") + 1) : s;
  return portOk(port) ? port : null;
}

/** `host:port` split at its last colon; a bare value is taken as the port. */
export function splitTarget(remote: string): { host: string; port: string } {
  const s = (remote ?? "").trim();
  const i = s.lastIndexOf(":");
  if (i < 0) return /^\d+$/.test(s) ? { host: "", port: s } : { host: s, port: "" };
  return { host: s.slice(0, i), port: s.slice(i + 1) };
}

export function joinTarget(host: string, port: string): string {
  const h = host.trim();
  const p = port.trim();
  return h || p ? `${h}:${p}` : "";
}

export function serverIssues(node: any): Issue[] {
  const out: Issue[] = [];
  const add = (section: EditorSection, field: string, message: string) => out.push({ section, field, message });
  const protocol = node.protocol ?? "ssh";
  const isSsh = protocol === "ssh";

  if (!String(node.name ?? "").trim()) add("connection", "name", "Give the server a name so you can find it.");
  const host = String(node.host ?? "").trim();
  if (!host) add("connection", "host", "Type the server's address or name.");
  else if (/\s/.test(host)) add("connection", "host", "An address has no spaces.");
  if (!portOk(String(node.port ?? ""))) add("connection", "port", "Use a port between 1 and 65535.");

  if (node.authType === "vault" && !node.credentialId) add("auth", "credentialId", "Pick a saved login, or another way to log in.");
  if (isSsh && node.authType === "custom_key" && !node.keyId) add("auth", "keyId", "Pick a key, load one from a file, or generate one.");

  if (isSsh && (node.proxyType === "socks5" || node.proxyType === "http")) {
    if (!String(node.proxyHost ?? "").trim()) add("proxy", "proxyHost", "Type the proxy's address.");
    if (!portOk(String(node.proxyPort ?? ""))) add("proxy", "proxyPort", "Use a port between 1 and 65535.");
  }

  if (isSsh) {
    const binds = new Map<string, number>();
    (node.tunnels ?? []).forEach((t: any, i: number) => {
      const key = t.rid ?? i;
      const port = bindPort(String(t.local ?? ""));
      if (!port) add("forward", `tunnel-${key}-local`, t.type === "R" ? "Use a server port between 1 and 65535." : "Use a local port between 1 and 65535.");
      else {
        // Local and dynamic forwards listen here, remote ones on the server.
        const side = `${t.type === "R" ? "R" : "L"}:${String(t.local).trim()}`;
        if (binds.has(side)) add("forward", `tunnel-${key}-local`, `Port ${port} is already used by forward ${binds.get(side)! + 1}.`);
        else binds.set(side, i);
      }
      if (t.type !== "D") {
        const target = splitTarget(String(t.remote ?? ""));
        if (!target.host.trim()) add("forward", `tunnel-${key}-host`, "Type where it goes, like localhost.");
        if (!portOk(target.port)) add("forward", `tunnel-${key}-port`, "Use a target port between 1 and 65535.");
      }
    });

    (node.mirrors ?? []).forEach((m: any, i: number) => {
      if (!String(m.local ?? "").trim()) add("mirrors", `mirror-${i}-local`, "Pick the folder on this computer.");
      if (!String(m.remote ?? "").trim()) add("mirrors", `mirror-${i}-remote`, "Type the folder on the server.");
    });
  }
  return out;
}
