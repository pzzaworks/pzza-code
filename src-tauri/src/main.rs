// Prevents an extra console window on Windows in release. Harmless elsewhere.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "macos")]
    if let Some(code) = pzzacode_lib::local_tmux::headless_exit_code() {
        std::process::exit(code);
    }
    pzzacode_lib::run();
}
