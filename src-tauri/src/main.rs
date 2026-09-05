// Prevents an extra console window on Windows in release. Harmless elsewhere.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    pzzacode_lib::run();
}
