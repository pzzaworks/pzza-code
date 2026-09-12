use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

// Desktops currently open, keyed by the device's Keychain service (unique per
// device), so a second "Open desktop" reuses the live window instead of
// stacking another. The background thread that waits on each viewer removes its
// entry when the window closes, so the state follows the real window's life.
fn open_desktops() -> &'static Mutex<HashMap<String, Launched>> {
    static R: OnceLock<Mutex<HashMap<String, Launched>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

// Whether a desktop is already open for a device (its Keychain service key).
#[tauri::command]
pub fn rdp_is_open(keychain_service: String) -> bool {
    open_desktops()
        .lock()
        .unwrap()
        .contains_key(&keychain_service)
}

// The selected SSH device and its saved desktop-sharing account.
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
#[derive(serde::Serialize, Clone)]
pub struct Launched {
    pub port: u16,
    pub mode: String,
}

#[derive(serde::Serialize, Debug)]
pub struct RdpFailure {
    code: &'static str,
    message: &'static str,
}

fn failure(code: &'static str) -> RdpFailure {
    let message = match code {
        "RDP_INVALID_OPTIONS" => "Check the remote server address and desktop account in Settings → Connections → Remote desktop.",
        "RDP_CREDENTIALS" => "Could not read the remote desktop credentials. Check the saved account and Keychain access, then try again.",
        "RDP_SETUP_FAILED" => "Remote desktop is unavailable on the server. Check that GNOME Remote Desktop is enabled, then try again.",
        "RDP_DESKTOP_LOCKED" => "The server's desktop is locked. Enable Remote Login on the server, or unlock its desktop before connecting.",
        "RDP_SSH_FAILED" => "Could not reach the server over SSH. Check its SSH connection, then try again.",
        "RDP_VIEWER_MISSING" => "The desktop viewer is missing. Install FreeRDP on this Mac, then try again.",
        "RDP_AUTH_FAILED" => "The server rejected the desktop login. Check its Remote Login credentials, then try again.",
        _ => "The remote desktop connection closed. Check Remote Login on the server and its SSH connection, then try again.",
    };
    RdpFailure { code, message }
}

#[derive(serde::Deserialize)]
struct RemoteLogin {
    port: u16,
    user: String,
    password: String,
    fingerprint: String,
}

#[derive(serde::Deserialize)]
struct RemoteState {
    login: Option<RemoteLogin>,
    locked: bool,
}

fn valid_line(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}

impl RemoteLogin {
    fn validate(&self) -> Result<(), RdpFailure> {
        if self.port == 0
            || !valid_line(&self.user, 256)
            || !valid_line(&self.password, 4096)
            || self.fingerprint.len() != 64
            || !self.fingerprint.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(failure("RDP_SETUP_FAILED"));
        }
        Ok(())
    }
}

fn select_remote_login(state: RemoteState) -> Result<Option<RemoteLogin>, RdpFailure> {
    if let Some(login) = state.login {
        login.validate()?;
        return Ok(Some(login));
    }
    if state.locked {
        return Err(failure("RDP_DESKTOP_LOCKED"));
    }
    Ok(None)
}

// Remote Login creates a login session even while desktop sharing is locked.
// Read its existing configuration through the trusted SSH connection; never
// replace system credentials or change the physical session's lock state.
fn remote_login(opts: &RdpOptions) -> Result<Option<RemoteLogin>, RdpFailure> {
    let script = r#"python3 - <<'PY'
import json, os, subprocess
os.environ['LC_ALL'] = 'C'
os.environ['XDG_RUNTIME_DIR'] = '/run/user/' + str(os.getuid())
os.environ['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=' + os.environ['XDG_RUNTIME_DIR'] + '/bus'
def run(args):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=6)
        return result.stdout if result.returncode == 0 else ''
    except (OSError, subprocess.TimeoutExpired):
        return ''
status = run(['sudo', '-n', 'grdctl', '--system', 'status', '--show-credentials'])
fields = dict(line.strip().split(':', 1) for line in status.splitlines() if ':' in line)
fields = {key: value.strip() for key, value in fields.items()}
login = None
if fields.get('Status') == 'enabled' and fields.get('Username') not in (None, '', '(empty)') and fields.get('Password') not in (None, '', '(empty)'):
    if run(['systemctl', 'is-active', 'gnome-remote-desktop.service']).strip() == 'active':
        login = {'port': int(fields.get('Port', '0')), 'user': fields['Username'], 'password': fields['Password'], 'fingerprint': fields.get('TLS fingerprint', '').replace(':', '')}
locked = False
if login is None:
    locked = run(['gdbus', 'call', '--session', '--dest', 'org.gnome.ScreenSaver', '--object-path', '/org/gnome/ScreenSaver', '--method', 'org.gnome.ScreenSaver.GetActive']).strip() == '(true,)'
print(json.dumps({'login': login, 'locked': locked}))
PY"#;
    let output = ssh_script(opts, script).map_err(|_| failure("RDP_SSH_FAILED"))?;
    if !output.status.success() {
        return Err(failure(if output.status.code() == Some(255) {
            "RDP_SSH_FAILED"
        } else {
            "RDP_SETUP_FAILED"
        }));
    }
    let state = serde_json::from_slice(&output.stdout).map_err(|_| failure("RDP_SETUP_FAILED"))?;
    select_remote_login(state)
}

fn ssh_script(opts: &RdpOptions, script: &str) -> std::io::Result<std::process::Output> {
    let mut child = Command::new("ssh")
        .args(ssh_base(opts.port, &opts.identity))
        .args(["-T", "--", &opts.host, "timeout 30s sh -s"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let result = child
        .stdin
        .take()
        .ok_or_else(|| std::io::Error::other("SSH input unavailable"))
        .and_then(|mut stdin| stdin.write_all(script.as_bytes()));
    if let Err(error) = result {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    child.wait_with_output()
}

const FREERDP_CANDIDATES: [&str; 2] = [
    "/opt/homebrew/bin/sdl-freerdp",
    "/usr/local/bin/sdl-freerdp",
];

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
        .args([
            "add-generic-password",
            "-U",
            "-s",
            service,
            "-a",
            account,
            "-w",
            password,
        ])
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
        "ServerAliveInterval=5".into(),
        "-o".into(),
        "ServerAliveCountMax=2".into(),
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

// Provision the saved desktop-sharing account only when Remote Login is not
// configured and the current desktop is unlocked. The script travels on stdin
// so its credentials are never embedded in the local SSH process arguments.
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
    let out = ssh_script(opts, &script).map_err(|_| "SSH setup failed")?;
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
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "pzzacode-{name}-{}-{timestamp}.log",
        std::process::id()
    ))
}

// Diagnostics are used only for classification, never copied into a notification.
fn viewer_failure(path: &PathBuf, sharing: bool) -> RdpFailure {
    let mut text = String::new();
    if let Ok(f) = File::open(path) {
        let _ = f.take(128 * 1024).read_to_string(&mut text);
    }
    classify_viewer_failure(&text, sharing)
}

fn classify_viewer_failure(text: &str, sharing: bool) -> RdpFailure {
    if text.contains("LOGON_FAILURE") || text.contains("AUTHENTICATION_FAILED") {
        failure("RDP_AUTH_FAILED")
    } else if sharing
        && (text.contains("ERRINFO_LOGOFF_BY_USER") || text.contains("Session creation inhibited"))
    {
        failure("RDP_DESKTOP_LOCKED")
    } else {
        failure("RDP_CONNECT_FAILED")
    }
}

fn private_log(path: &PathBuf) -> std::io::Result<File> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

struct DesktopProcess {
    child: Child,
    log: PathBuf,
}

impl Drop for DesktopProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.log);
    }
}

// A private ssh tunnel to the device's RDP port on a fresh local port. Runs
// outside any ControlMaster so it is exactly what we asked for and dies with
// the viewer instead of lingering (and being reused) inside a shared master.
fn open_tunnel(opts: &RdpOptions, remote_port: u16) -> Result<(u16, DesktopProcess), RdpFailure> {
    let local = free_port().map_err(|_| failure("RDP_SSH_FAILED"))?;
    let log = log_path(&format!("rdp-tunnel-{local}"));
    let logf = private_log(&log).map_err(|_| failure("RDP_SSH_FAILED"))?;
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
    args.push("--".into());
    args.push(opts.host.clone());
    let child = Command::new("ssh")
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(logf))
        .spawn()
        .map_err(|_| failure("RDP_SSH_FAILED"))?;
    let mut process = DesktopProcess { child, log };
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if port_open(local) {
            return Ok((local, process));
        }
        if !matches!(process.child.try_wait(), Ok(None)) {
            return Err(failure("RDP_SSH_FAILED"));
        }
        thread::sleep(Duration::from_millis(150));
    }
    Err(failure("RDP_SSH_FAILED"))
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
pub async fn rdp_launch(opts: RdpOptions) -> Result<Launched, RdpFailure> {
    tauri::async_runtime::spawn_blocking(move || launch_blocking(opts))
        .await
        .map_err(|_| failure("RDP_TASK_FAILED"))?
}

fn validate_options(opts: &RdpOptions) -> Result<(), RdpFailure> {
    let mut user = opts.user.bytes();
    if !matches!(user.next(), Some(c) if c.is_ascii_alphabetic() || c == b'_')
        || opts.user.len() > 64
        || !user.all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        || !valid_line(&opts.host, 512)
        || opts.host.starts_with('-')
        || opts.host.chars().any(char::is_whitespace)
        || !opts.keychain_service.starts_with("pzzacode-rdp-")
        || !valid_line(&opts.keychain_service, 256)
        || opts.port == Some(0)
        || opts
            .identity
            .as_ref()
            .is_some_and(|path| path.contains('\0'))
    {
        return Err(failure("RDP_INVALID_OPTIONS"));
    }
    Ok(())
}

fn launch_blocking(opts: RdpOptions) -> Result<Launched, RdpFailure> {
    validate_options(&opts)?;
    if let Some(existing) = open_desktops()
        .lock()
        .unwrap()
        .get(&opts.keychain_service)
        .cloned()
    {
        return Ok(existing);
    }
    let bin = freerdp_bin().map_err(|_| failure("RDP_VIEWER_MISSING"))?;
    let (remote_port, mode, user, password, certificate) = if let Some(login) = remote_login(&opts)?
    {
        (
            login.port,
            "Remote Login".to_string(),
            login.user,
            login.password,
            format!("/cert:fingerprint:sha256:{}", login.fingerprint),
        )
    } else {
        let password = match keychain_password(&opts.keychain_service) {
            Some(pw) => pw,
            None => {
                let pw = crate::agent::random_hex(16).ok_or_else(|| failure("RDP_CREDENTIALS"))?;
                keychain_set(&opts.keychain_service, &opts.user, &pw)
                    .map_err(|_| failure("RDP_CREDENTIALS"))?;
                pw
            }
        };
        // The provisioning script accepts only the generated hexadecimal secret.
        if !valid_line(&password, 4096) || !password.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(failure("RDP_CREDENTIALS"));
        }
        let (port, mode) =
            ensure_remote(&opts, &password).map_err(|_| failure("RDP_SETUP_FAILED"))?;
        (
            port,
            mode,
            opts.user.clone(),
            password,
            "/cert:ignore".to_string(),
        )
    };
    let (local, tunnel) = open_tunnel(&opts, remote_port)?;
    let log = log_path(&format!("rdp-viewer-{local}"));
    let logf = private_log(&log).map_err(|_| failure("RDP_CONNECT_FAILED"))?;
    let errf = logf
        .try_clone()
        .map_err(|_| failure("RDP_CONNECT_FAILED"))?;
    let child = Command::new(bin)
        .arg("/args-from:stdin")
        .stdin(Stdio::piped())
        .stdout(Stdio::from(logf))
        .stderr(Stdio::from(errf))
        .spawn()
        .map_err(|_| failure("RDP_CONNECT_FAILED"))?;
    let mut viewer = DesktopProcess { child, log };
    // Keep credentials out of process listings. FreeRDP reads one argument per
    // line, including the certificate fingerprint verified through SSH.
    let arguments = [
        format!("/v:127.0.0.1:{local}"),
        format!("/u:{user}"),
        format!("/p:{password}"),
        certificate,
        "/ipv4:force".into(),
        "/f".into(),
        "/dynamic-resolution".into(),
        "/network:auto".into(),
        "/gfx".into(),
        "+clipboard".into(),
        "/log-level:WARN".into(),
    ];
    let mut input = viewer
        .child
        .stdin
        .take()
        .ok_or_else(|| failure("RDP_CONNECT_FAILED"))?;
    input
        .write_all(format!("{}\n", arguments.join("\n")).as_bytes())
        .map_err(|_| failure("RDP_CONNECT_FAILED"))?;
    drop(input);

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        match viewer.child.try_wait() {
            Ok(None) => {}
            Ok(Some(_)) => return Err(viewer_failure(&viewer.log, mode != "Remote Login")),
            Err(_) => return Err(failure("RDP_CONNECT_FAILED")),
        }
        thread::sleep(Duration::from_millis(200));
    }
    let launched = Launched {
        port: remote_port,
        mode,
    };
    let key = opts.keychain_service;
    open_desktops()
        .lock()
        .unwrap()
        .insert(key.clone(), launched.clone());
    thread::spawn(move || {
        let _ = viewer.child.wait();
        drop(viewer);
        drop(tunnel);
        open_desktops().lock().unwrap().remove(&key);
    });
    Ok(launched)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dropping_a_desktop_process_reaps_it_and_removes_its_private_log() {
        use std::os::unix::fs::PermissionsExt;
        let log = log_path("rdp-cleanup-test");
        let output = private_log(&log).unwrap();
        assert_eq!(
            output.metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
        let child = Command::new("sleep")
            .arg("30")
            .stdout(Stdio::from(output))
            .spawn()
            .unwrap();
        let pid = child.id();
        drop(DesktopProcess {
            child,
            log: log.clone(),
        });
        assert!(!log.exists());
        let result =
            unsafe { libc::waitpid(pid as libc::pid_t, std::ptr::null_mut(), libc::WNOHANG) };
        assert_eq!(result, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD)
        );
    }

    #[test]
    fn remote_login_is_selected_while_desktop_sharing_is_locked() {
        let state = RemoteState {
            login: Some(RemoteLogin {
                port: 3389,
                user: "remote-account".into(),
                password: crate::agent::random_hex(16).unwrap(),
                fingerprint: "ab".repeat(32),
            }),
            locked: true,
        };
        assert_eq!(select_remote_login(state).unwrap().unwrap().port, 3389);
        assert_eq!(
            select_remote_login(RemoteState {
                login: None,
                locked: true
            })
            .err()
            .unwrap()
            .code,
            "RDP_DESKTOP_LOCKED"
        );
        assert!(select_remote_login(RemoteState {
            login: None,
            locked: false
        })
        .unwrap()
        .is_none());
    }

    #[test]
    fn remote_credentials_cannot_inject_viewer_arguments() {
        let mut login = RemoteLogin {
            port: 3389,
            user: "remote-account".into(),
            password: crate::agent::random_hex(16).unwrap(),
            fingerprint: "ab".repeat(32),
        };
        assert!(login.validate().is_ok());
        login.user.push_str("\n/cert:ignore");
        assert!(login.validate().is_err());
        login.user = "remote-account".into();
        login.fingerprint.push(':');
        assert!(login.validate().is_err());
    }

    #[test]
    fn user_names_match_the_settings_validation_and_ssh_options_are_rejected() {
        let mut opts = RdpOptions {
            host: "user@server".into(),
            port: None,
            identity: None,
            user: "remote_account-2".into(),
            keychain_service: "pzzacode-rdp-test".into(),
        };
        assert!(validate_options(&opts).is_ok());
        opts.host = "-oProxyCommand=command".into();
        assert!(validate_options(&opts).is_err());
        opts.host = "server\ncommand".into();
        assert!(validate_options(&opts).is_err());
    }

    #[test]
    fn diagnostic_errors_are_classified_without_exposing_logs() {
        assert_eq!(
            classify_viewer_failure("[rdp] ERRINFO_LOGOFF_BY_USER", true).code,
            "RDP_DESKTOP_LOCKED"
        );
        assert_eq!(
            classify_viewer_failure("[rdp] ERRINFO_LOGOFF_BY_USER", false).code,
            "RDP_CONNECT_FAILED"
        );
        assert_eq!(
            classify_viewer_failure("[rdp] ERRCONNECT_LOGON_FAILURE", false).code,
            "RDP_AUTH_FAILED"
        );
        let error = classify_viewer_failure("[rdp] arbitrary diagnostic output", false);
        assert!(!error.message.contains("[rdp]"));
        assert!(error.message.len() < 200);
    }
}
