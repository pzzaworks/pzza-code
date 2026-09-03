use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;

// One running PTY. The master is kept for resizing and cloning readers; the
// writer feeds keystrokes in; the child lets us terminate on kill.
struct PtyHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

struct Inner {
    next_id: u32,
    ptys: HashMap<u32, PtyHandle>,
}

impl Default for Inner {
    fn default() -> Self {
        Inner {
            next_id: 1,
            ptys: HashMap::new(),
        }
    }
}

#[derive(Default)]
pub struct PtyState {
    inner: Mutex<Inner>,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

// Spawn a PTY-backed command and stream its output over `on_data` as base64
// chunks. Returns an id used by the write/resize/kill commands.
#[tauri::command]
pub fn pty_spawn(
    state: tauri::State<'_, PtyState>,
    cmd: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_data: Channel<String>,
) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size(cols, rows))
        .map_err(|e| e.to_string())?;

    let mut builder = CommandBuilder::new(&cmd);
    builder.args(&args);
    if let Some(dir) = &cwd {
        builder.cwd(dir);
    }
    // Give programs a sensible terminal identity.
    builder.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(builder)
        .map_err(|e| e.to_string())?;

    // Dropping the slave lets the reader observe EOF when the child exits.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = {
        let mut inner = state.inner.lock().unwrap();
        let id = inner.next_id;
        inner.next_id += 1;
        inner.ptys.insert(
            id,
            PtyHandle {
                master: pair.master,
                writer,
                child,
            },
        );
        id
    };

    // Blocking reader on its own thread; forwards raw output to the frontend.
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let encoded = STANDARD.encode(&buf[..n]);
                    if on_data.send(encoded).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: tauri::State<'_, PtyState>, id: u32, data: String) -> Result<(), String> {
    let mut inner = state.inner.lock().unwrap();
    let handle = inner
        .ptys
        .get_mut(&id)
        .ok_or_else(|| format!("no pty {id}"))?;
    handle
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    handle.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<'_, PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let inner = state.inner.lock().unwrap();
    let handle = inner.ptys.get(&id).ok_or_else(|| format!("no pty {id}"))?;
    handle
        .master
        .resize(size(cols, rows))
        .map_err(|e| e.to_string())
}

// Terminates the local PTY. Remote persistence is a property of tmux on the
// devbox, not of this handle: detaching a tmux session leaves it running.
#[tauri::command]
pub fn pty_kill(state: tauri::State<'_, PtyState>, id: u32) -> Result<(), String> {
    let mut inner = state.inner.lock().unwrap();
    if let Some(mut handle) = inner.ptys.remove(&id) {
        let _ = handle.child.kill();
    }
    Ok(())
}
