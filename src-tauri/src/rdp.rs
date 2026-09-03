use std::net::TcpStream;
use std::process::Command;
use std::time::Duration;

// Launches the devbox Linux desktop over RDP, mirroring devbox-rdp / Devbox.app:
// an ssh tunnel exposes the firewalled remote 3389 on a local port, the RDP
// password is read from the login Keychain at launch (never stored here), and a
// bundled/homebrew sdl-freerdp connects with the pinned cert fingerprint.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpOptions {
    host: String,
    tunnel_port: u16,
    remote_port: u16,
    user: String,
    cert_fingerprint: String,
    keychain_service: String,
    freerdp_bin: String,
}

fn tunnel_up(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}");
    match addr.parse() {
        Ok(sa) => TcpStream::connect_timeout(&sa, Duration::from_millis(400)).is_ok(),
        Err(_) => false,
    }
}

// Report whether the RDP tunnel's local port is already listening.
#[tauri::command]
pub fn rdp_status(tunnel_port: u16) -> bool {
    tunnel_up(tunnel_port)
}

fn ensure_tunnel(host: &str, tunnel_port: u16, remote_port: u16) -> Result<(), String> {
    if tunnel_up(tunnel_port) {
        return Ok(());
    }
    let spec = format!("127.0.0.1:{tunnel_port}:127.0.0.1:{remote_port}");
    let status = Command::new("ssh")
        .args([
            "-f",
            "-N",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "ConnectTimeout=10",
            "-L",
            &spec,
            host,
        ])
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("SSH tunnel to the devbox failed. Is it reachable?".to_string())
    }
}

fn keychain_password(service: &str) -> Result<String, String> {
    let out = Command::new("security")
        .args(["find-generic-password", "-s", service, "-w"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("Keychain entry '{service}' not found."));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// Open the RDP desktop in its own sdl-freerdp window. The window is external by
// design (the current, working devbox-rdp approach); in-tile embedding is a
// later phase.
#[tauri::command]
pub fn rdp_launch(opts: RdpOptions) -> Result<(), String> {
    ensure_tunnel(&opts.host, opts.tunnel_port, opts.remote_port)?;
    let password = keychain_password(&opts.keychain_service)?;

    // Argument set matches Devbox.app exactly so behavior is identical.
    Command::new(&opts.freerdp_bin)
        .arg(format!("/v:127.0.0.1:{}", opts.tunnel_port))
        .arg(format!("/u:{}", opts.user))
        .arg(format!("/p:{password}"))
        .arg("/ipv4:force")
        .arg(format!(
            "/cert:fingerprint:sha256:{}",
            opts.cert_fingerprint
        ))
        .arg("/dynamic-resolution")
        .arg("/network:lan")
        .arg("/gfx:AVC444")
        .arg("-compression")
        .arg("+clipboard")
        .spawn()
        .map_err(|e| format!("could not launch sdl-freerdp: {e}"))?;
    Ok(())
}
