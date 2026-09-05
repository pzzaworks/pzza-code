use std::fs::File;
use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

// Opens a device's Linux desktop over RDP. One call does the whole job: read
// (or create) the RDP password in the login Keychain, make sure GNOME Remote
// Desktop on the device is enabled with exactly those credentials, open a
// dedicated ssh tunnel on a fresh local port, and launch sdl-freerdp through
// it. Nothing is reused between launches - a stale tunnel (ssh multiplexing
// keeps old forwards alive inside the control master) or drifted credentials
// cannot break the next attempt.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpOptions {
    host: String, // ssh target: alias or user@host
    port: Option<u16>,
    identity: Option<String>,
    user: String, // RDP account on the device
    keychain_service: String,
}

// What the launch found on the device: the daemon mode and the port it serves.
#[derive(serde::Serialize)]
pub struct Launched {
    pub port: u16,
    pub mode: String,
}

const FREERDP_CANDIDATES: [&str; 2] = ["/opt/homebrew/bin/sdl-freerdp", "/usr/local/bin/sdl-freerdp"];

fn port_open(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}");
    match addr.parse() {
        Ok(sa) => TcpStream::connect_timeout(&sa, Duration::from_millis(300)).is_ok(),
        Err(_) => false,
    }
}

// Ask the kernel for a free loopback port; it is released again before the
// tunnel binds it, which is fine for a port nobody else is racing for.
fn free_port() -> Result<u16, String> {
    let l = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    l.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

fn keychain_password(service: &str) -> Option<String> {
    let out = Command::new("security")
        .args(["find-generic-password", "-s", service, "-w"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let pw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!pw.is_empty()).then_some(pw)
}

// Store an RDP password in the login Keychain (created/updated), so it is never
// persisted by the app in plaintext.
fn keychain_set(service: &str, account: &str, password: &str) -> Result<(), String> {
    let status = Command::new("security")
        .args(["add-generic-password", "-U", "-s", service, "-a", account, "-w", password])
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("could not write the RDP password to the Keychain".into())
    }
}

fn ssh_base(port: Option<u16>, identity: &Option<String>) -> Vec<String> {
    let mut args = vec![
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ConnectTimeout=12".into(),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
    ];
    if let Some(p) = port {
        args.push("-p".into());
        args.push(p.to_string());
    }
    if let Some(id) = identity {
        if !id.trim().is_empty() {
            args.push("-i".into());
            args.push(id.clone());
        }
    }
    args
}

// Make GNOME Remote Desktop on the device serve RDP with the given credentials
// and report the port. Prefers the *headless* daemon (it spins up a virtual
// monitor per client; the session daemon accepts and immediately drops clients
// on a box with no desktop) on its own port, since 3389 is usually held by the
// system-level remote-login daemon. Only restarts the daemon when it is not
// listening or its credentials differ from ours, so an open desktop survives
// a second launch. Credentials are alphanumeric, so single quotes suffice.
fn ensure_remote(opts: &RdpOptions, password: &str) -> Result<(u16, String), String> {
    let script = format!(
        r#"set -e
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus
if ! command -v grdctl >/dev/null 2>&1; then echo "ERROR: gnome-remote-desktop (grdctl) is not installed on the device"; exit 3; fi
D="$HOME/.local/share/gnome-remote-desktop"; mkdir -p "$D"
if [ ! -f "$D/rdp-tls.crt" ]; then
  openssl req -new -newkey rsa:2048 -days 3650 -nodes -x509 -subj "/CN=pzzacode-$(hostname)" -out "$D/rdp-tls.crt" -keyout "$D/rdp-tls.key" >/dev/null 2>&1
fi
MODE=""; PORT=3389; UNIT=gnome-remote-desktop.service
if grdctl --headless status >/dev/null 2>&1; then MODE="--headless"; PORT=3390; UNIT=gnome-remote-desktop-headless.service; fi
RESTART=0
CUR_USER=$(grdctl $MODE status --show-credentials 2>/dev/null | sed -n 's/^[[:space:]]*Username: //p' | head -1)
CUR_PASS=$(grdctl $MODE status --show-credentials 2>/dev/null | sed -n 's/^[[:space:]]*Password: //p' | head -1)
if [ "$CUR_USER" != '{user}' ] || [ "$CUR_PASS" != '{password}' ]; then
  grdctl $MODE rdp set-credentials '{user}' '{password}'
  RESTART=1
fi
grdctl $MODE rdp enable
grdctl $MODE rdp disable-view-only >/dev/null 2>&1 || true
grdctl $MODE rdp set-tls-cert "$D/rdp-tls.crt"
grdctl $MODE rdp set-tls-key "$D/rdp-tls.key"
if [ -n "$MODE" ]; then
  grdctl --headless rdp set-port $PORT >/dev/null 2>&1 || true
  systemctl --user disable --now gnome-remote-desktop.service >/dev/null 2>&1 || true
fi
listening() {{ ss -tlnH 2>/dev/null | grep -q ":$PORT "; }}
if [ "$RESTART" = 1 ] || ! listening; then
  systemctl --user reset-failed $UNIT >/dev/null 2>&1 || true
  systemctl --user enable $UNIT >/dev/null 2>&1 || true
  systemctl --user restart $UNIT >/dev/null 2>&1 || true
  for i in 1 2 3 4 5 6 7 8 9 10; do listening && break; sleep 0.5; done
fi
listening || {{ echo "ERROR: the RDP daemon is not listening on port $PORT"; exit 4; }}
echo "MODE:${{MODE:-session}}"
echo "PORT:$PORT""#,
        user = opts.user,
        password = password,
    );
    let mut args = ssh_base(opts.port, &opts.identity);
    args.push(opts.host.clone());
    args.push(script);
    let out = Command::new("ssh")
        .args(&args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = |prefix: &str| {
        stdout
            .lines()
            .filter_map(|l| l.strip_prefix(prefix))
            .map(|s| s.trim().to_string())
            .last()
    };
    match line("PORT:").and_then(|p| p.parse::<u16>().ok()) {
        Some(port) if out.status.success() => {
            Ok((port, line("MODE:").unwrap_or_else(|| "session".into())))
        }
        _ => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let detail = stdout
                .lines()
                .chain(stderr.lines())
                .filter(|l| !l.trim().is_empty())
                .last()
                .unwrap_or("ssh to the device failed")
                .trim()
                .to_string();
            Err(format!("Remote desktop setup failed: {detail}"))
        }
    }
}

fn log_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("pzzacode-{name}.log"))
}

// Last few meaningful lines of a process log, for error messages.
fn log_tail(path: &PathBuf) -> String {
    let mut text = String::new();
    if let Ok(mut f) = File::open(path) {
        let _ = f.read_to_string(&mut text);
    }
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let errors: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|l| l.contains("ERR") || l.contains("error"))
        .collect();
    let pick = if errors.is_empty() { &lines } else { &errors };
    pick.iter()
        .rev()
        .take(3)
        .rev()
        .map(|l| l.trim())
        .collect::<Vec<_>>()
        .join(" | ")
}

// A private ssh tunnel to the device's RDP port on a fresh local port. Runs
// outside any ControlMaster so it is exactly what we asked for and dies with
// the viewer instead of lingering (and being reused) inside a shared master.
fn open_tunnel(opts: &RdpOptions, remote_port: u16) -> Result<(u16, Child), String> {
    let local = free_port()?;
    let log = log_path(&format!("rdp-tunnel-{local}"));
    let logf = File::create(&log).map_err(|e| e.to_string())?;
    let mut args = ssh_base(opts.port, &opts.identity);
    args.extend(
        [
            "-o",
            "ControlMaster=no",
            "-o",
            "ControlPath=none",
            "-o",
            "ExitOnForwardFailure=yes",
            "-N",
            "-L",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    args.push(format!("127.0.0.1:{local}:127.0.0.1:{remote_port}"));
    args.push(opts.host.clone());
    let mut child = Command::new("ssh")
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(logf))
        .spawn()
        .map_err(|e| format!("could not start ssh: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if port_open(local) {
            return Ok((local, child));
        }
        if let Ok(Some(_)) = child.try_wait() {
            return Err(format!("SSH tunnel to the device failed: {}", log_tail(&log)));
        }
        thread::sleep(Duration::from_millis(150));
    }
    let _ = child.kill();
    Err("SSH tunnel to the device did not come up in time.".into())
}

fn freerdp_bin() -> Result<&'static str, String> {
    FREERDP_CANDIDATES
        .iter()
        .copied()
        .find(|p| std::path::Path::new(p).exists())
        .ok_or_else(|| "sdl-freerdp is not installed on this Mac (brew install freerdp).".into())
}

// Open the device's desktop in its own sdl-freerdp window. The heavy work (ssh
// provisioning, tunnel, waiting for the viewer) can take many seconds, so it
// runs on a blocking thread off the UI: an async command on Tauri's runtime,
// with the work moved to spawn_blocking, keeps the window responsive the whole
// time instead of freezing until the desktop appears.
#[tauri::command]
pub async fn rdp_launch(opts: RdpOptions) -> Result<Launched, String> {
    tauri::async_runtime::spawn_blocking(move || launch_blocking(opts))
        .await
        .map_err(|e| format!("remote desktop task failed: {e}"))?
}

// The device's desktop in its own sdl-freerdp window. The window is external by
// design; in-tile embedding is a later phase. Returns only once the viewer has
// stayed up for a moment, so a connection or logon failure comes back as an
// error instead of a window that flashes and closes.
fn launch_blocking(opts: RdpOptions) -> Result<Launched, String> {
    if opts.user.is_empty() || opts.user.chars().any(|c| !c.is_ascii_alphanumeric()) {
        return Err("the RDP user must be alphanumeric".into());
    }
    let bin = freerdp_bin()?;
    let password = match keychain_password(&opts.keychain_service) {
        Some(pw) => pw,
        None => {
            let pw = crate::agent::random_hex(16).ok_or("could not generate an RDP password")?;
            keychain_set(&opts.keychain_service, &opts.user, &pw)?;
            pw
        }
    };
    let (remote_port, mode) = ensure_remote(&opts, &password)?;
    let (local, mut tunnel) = open_tunnel(&opts, remote_port)?;

    let log = log_path(&format!("rdp-viewer-{local}"));
    let logf = File::create(&log).map_err(|e| e.to_string())?;
    let errf = logf.try_clone().map_err(|e| e.to_string())?;
    let mut viewer = match Command::new(bin)
        .arg(format!("/v:127.0.0.1:{local}"))
        .arg(format!("/u:{}", opts.user))
        .arg(format!("/p:{password}"))
        .arg("/ipv4:force")
        // The session already rides an authenticated, encrypted ssh tunnel to
        // 127.0.0.1, so the daemon's self-signed TLS cert adds nothing - accept
        // it instead of pinning a fingerprint that drifts when it regenerates.
        .arg("/cert:ignore")
        // Open straight into fullscreen (toggle with Ctrl+Alt+Enter); the
        // remote resizes to match via dynamic-resolution.
        .arg("/f")
        .arg("/dynamic-resolution")
        .arg("/network:lan")
        .arg("/gfx:AVC444")
        .arg("-compression")
        .arg("+clipboard")
        .stdin(Stdio::null())
        .stdout(Stdio::from(logf))
        .stderr(Stdio::from(errf))
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            let _ = tunnel.kill();
            return Err(format!("could not launch sdl-freerdp: {e}"));
        }
    };

    // A logon or protocol failure makes the viewer exit within a second or two.
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if let Ok(Some(status)) = viewer.try_wait() {
            let _ = tunnel.kill();
            return Err(format!(
                "The desktop closed right away ({}): {}",
                status.code().map(|c| format!("exit {c}")).unwrap_or_else(|| "signal".into()),
                log_tail(&log)
            ));
        }
        thread::sleep(Duration::from_millis(200));
    }
    // The tunnel lives exactly as long as the viewer window.
    thread::spawn(move || {
        let _ = viewer.wait();
        let _ = tunnel.kill();
        let _ = tunnel.wait();
    });
    Ok(Launched {
        port: remote_port,
        mode,
    })
}
