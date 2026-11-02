//! "Test connection" in the server editor: whether a server as typed (not yet
//! saved) can be reached. It resolves the name, opens the port and, for SSH,
//! reads the host key and says whether it's trusted. It stops there: it logs
//! in with nothing, never asks about a key, and never saves one.

use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use russh::client;
use russh::keys::PublicKeyOrCertificate;
use serde::Serialize;

const STEP_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Serialize, Default)]
pub struct ProbeResult {
    /// Where `~/.ssh/config` sends an alias (`HostName`, `Port`), when it does.
    pub target: Option<String>,
    /// The addresses the name resolved to; empty when a proxy resolves it.
    pub addresses: Vec<String>,
    /// The time to open the port, in milliseconds.
    pub connect_ms: Option<u64>,
    pub host_key: Option<HostKey>,
    /// The step that failed ("dns", "port", "ssh"), with why.
    pub failed: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct HostKey {
    pub key_type: String,
    pub fingerprint: String,
    /// "known", "known_hosts", "changed", "new", "refused" or "certificate".
    pub trust: String,
    pub note: Option<String>,
}

fn fail(mut r: ProbeResult, step: &str, error: impl Into<String>) -> ProbeResult {
    r.failed = Some(step.into());
    r.error = Some(error.into());
    r
}

/// The name's addresses, for the live hint under Host. An IP address comes
/// back as itself; an alias in `~/.ssh/config` resolves as its HostName.
#[tauri::command]
pub async fn resolve_host(host: String, port: u16) -> Result<Vec<String>, String> {
    let host = host.trim();
    if host.is_empty() {
        return Ok(Vec::new());
    }
    let t = crate::ConfigTarget::resolve(host, port, "", None).await;
    lookup(&t.host, t.port).await
}

async fn lookup(host: &str, port: u16) -> Result<Vec<String>, String> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(vec![ip.to_string()]);
    }
    let addrs = tokio::time::timeout(STEP_TIMEOUT, tokio::net::lookup_host((host, port)))
        .await
        .map_err(|_| format!("Looking up {host} timed out."))?
        .map_err(|_| format!("{host} doesn't resolve to an address."))?;
    let mut out: Vec<String> = Vec::new();
    for a in addrs {
        let s = a.ip().to_string();
        if !out.contains(&s) {
            out.push(s);
        }
    }
    Ok(out)
}

/// What the handshake learnt about the host key; the handler refuses every
/// key, so the connection ends before any login.
struct ProbeHandler {
    db: Arc<std::sync::Mutex<Option<rusqlite::Connection>>>,
    host: String,
    port: u16,
    trust: Option<Arc<crate::known_hosts::HostTrust>>,
    seen: Arc<std::sync::Mutex<Option<HostKey>>>,
}

impl client::Handler for ProbeHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, offered: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let file_verdict = match (offered, &self.trust) {
            (PublicKeyOrCertificate::PublicKey { key, .. }, Some(t)) => Some(t.check_key(key)),
            (PublicKeyOrCertificate::Certificate(cert), Some(t)) => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                Some(t.check_certificate(cert, now))
            }
            _ => None,
        };
        let key = match crate::ssh_manager::plain_host_key(offered) {
            Some(k) => k,
            None => {
                let trust = match file_verdict {
                    Some(crate::known_hosts::Verdict::Trusted(_)) => "known_hosts",
                    _ => "certificate",
                };
                if let Ok(mut s) = self.seen.lock() {
                    *s = Some(HostKey { key_type: "certificate".into(), fingerprint: String::new(), trust: trust.into(), note: None });
                }
                return Ok(false);
            }
        };
        let fingerprint = crate::ssh_manager::host_key_fingerprint(key);
        let key_type = key.algorithm().to_string();
        let (trust, note) = match file_verdict {
            Some(crate::known_hosts::Verdict::Trusted(why)) => ("known_hosts".to_string(), Some(why)),
            Some(crate::known_hosts::Verdict::Refused(why)) => ("refused".to_string(), Some(why)),
            other => {
                let note = match other {
                    Some(crate::known_hosts::Verdict::Undecided(n)) => n,
                    _ => None,
                };
                let verdict = self
                    .db
                    .lock()
                    .ok()
                    .and_then(|g| g.as_ref().and_then(|c| crate::ssh_manager::judge_host_key(c, &self.host, self.port, &fingerprint).ok()));
                let trust = match verdict {
                    Some(crate::ssh_manager::HostKeyVerdict::Known) => "known",
                    Some(crate::ssh_manager::HostKeyVerdict::Changed { .. }) => "changed",
                    _ => "new",
                };
                (trust.to_string(), note)
            }
        };
        if let Ok(mut s) = self.seen.lock() {
            *s = Some(HostKey { key_type, fingerprint, trust, note });
        }
        Ok(false)
    }
}

/// Test a server as the editor holds it. `protocol` other than "ssh" stops
/// after the port. A SOCKS5 or HTTP proxy is used as a connection would, and
/// then the proxy resolves the name. A jump host isn't gone through: the
/// editor tests the jump host itself and says so.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn test_server_connection(
    db_state: tauri::State<'_, crate::DbState>,
    host: String,
    port: u16,
    protocol: String,
    proxy_type: String,
    proxy_host: String,
    proxy_port: u16,
) -> Result<ProbeResult, String> {
    let mut r = ProbeResult::default();
    let host = host.trim().to_string();
    if host.is_empty() {
        return Ok(fail(r, "dns", "There's no host to test."));
    }
    let is_ssh = protocol == "ssh";
    let mut target = if is_ssh {
        crate::ConfigTarget::resolve(&host, port, "", None).await
    } else {
        crate::ConfigTarget::apply(&host, port, "", None)
    };
    if target.host != host || target.port != port {
        r.target = Some(format!("{}:{}", target.host, target.port));
    }
    let own_route = match proxy_type.as_str() {
        "socks5" => Some("SOCKS5 proxy"),
        "http" => Some("HTTP proxy"),
        _ => None,
    };
    if is_ssh && own_route.is_none() {
        match target.proxy(None) {
            Some(crate::ssh_config::Proxy::Command(_)) => {
                return Ok(fail(r, "port", "~/.ssh/config reaches this server through a ProxyCommand, which a test doesn't run. Connect to try it."));
            }
            Some(crate::ssh_config::Proxy::Jump(_)) => {
                return Ok(fail(r, "port", "~/.ssh/config reaches this server through a ProxyJump, which a test doesn't use. Connect to try it."));
            }
            _ => {}
        }
    }

    let started = Instant::now();
    let stream: Box<dyn crate::monitor::AsyncStream> = match own_route {
        None => {
            r.addresses = match lookup(&target.host, target.port).await {
                Ok(a) => a,
                Err(e) => return Ok(fail(r, "dns", e)),
            };
            let started = Instant::now();
            let tcp = match tokio::time::timeout(STEP_TIMEOUT, tokio::net::TcpStream::connect((target.host.as_str(), target.port))).await {
                Err(_) => return Ok(fail(r, "port", format!("Port {} didn't answer in {} s: a firewall may be dropping it.", target.port, STEP_TIMEOUT.as_secs()))),
                Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionRefused => {
                    return Ok(fail(r, "port", format!("Port {} refused the connection: nothing is listening there.", target.port)))
                }
                Ok(Err(e)) => return Ok(fail(r, "port", format!("Couldn't open port {}: {e}", target.port))),
                Ok(Ok(s)) => s,
            };
            r.connect_ms = Some(started.elapsed().as_millis() as u64);
            let _ = tcp.set_nodelay(true);
            Box::new(tcp)
        }
        Some(_) => {
            let auth = crate::monitor::NodeAuth {
                host: target.host.clone(),
                port: target.port,
                username: String::new(),
                password: None,
                private_key: None,
                passphrase: None,
                proxy_type: proxy_type.clone(),
                proxy_host: Some(proxy_host.trim().to_string()),
                proxy_port: Some(proxy_port),
            };
            match crate::monitor::open_transport(&auth, STEP_TIMEOUT).await {
                Ok(s) => {
                    r.connect_ms = Some(started.elapsed().as_millis() as u64);
                    s
                }
                Err(e) => return Ok(fail(r, "port", e)),
            }
        }
    };
    if !is_ssh {
        return Ok(r);
    }

    let known_files = target.known_hosts_files("");
    let trust = crate::known_hosts::for_host(known_files, &target.host, target.port).await;
    let mut notes = Vec::new();
    let config = crate::client_config_for_target(&db_state.conn, &target.host, target.port, trust.as_ref(), target.host_key_algorithms().as_deref(), &mut notes);
    let seen = Arc::new(std::sync::Mutex::new(None));
    let handler = ProbeHandler {
        db: Arc::clone(&db_state.conn),
        host: target.host.clone(),
        port: target.port,
        trust: trust.map(Arc::new),
        seen: Arc::clone(&seen),
    };
    let outcome = tokio::time::timeout(STEP_TIMEOUT * 2, client::connect_stream(Arc::new(config), crate::monitor::StreamBox(stream), handler)).await;
    let key = seen.lock().ok().and_then(|s| s.clone());
    match (key, outcome) {
        (Some(k), _) => r.host_key = Some(k),
        (None, Err(_)) => return Ok(fail(r, "ssh", "The port is open, but no SSH server answered there in time.")),
        (None, Ok(Err(e))) => return Ok(fail(r, "ssh", format!("The port is open, but the SSH handshake failed: {e}"))),
        (None, Ok(Ok(_))) => return Ok(fail(r, "ssh", "The server didn't show a host key.")),
    }
    Ok(r)
}
