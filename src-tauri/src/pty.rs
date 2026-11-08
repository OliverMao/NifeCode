use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
}

#[derive(serde::Deserialize)]
pub struct SshTarget {
    pub target: String,
    pub port: u16,
    pub cwd: Option<String>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<u32, Session>>,
    next: AtomicU32,
}

#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    st: State<PtyState>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    ssh: Option<SshTarget>,
) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = match &ssh {
        // 远端终端：直接 ssh -t 过去（密码认证也能用，因为走的是交互式 PTY）
        Some(t) => {
            let mut c = CommandBuilder::new("ssh");
            c.arg("-t");
            c.arg("-p");
            c.arg(t.port.to_string());
            c.arg("-o");
            c.arg("ServerAliveInterval=30");
            if let Some(key) = crate::fsops::current_identity() {
                c.arg("-i");
                c.arg(key);
            }
            c.arg(&t.target);
            if let Some(dir) = &t.cwd {
                c.arg(format!("cd {} && exec \"$SHELL\"", crate::fsops::shq(dir)));
            }
            // 存过密码就自动填，不用每次手输
            for (k, v) in crate::fsops::secret_env(&t.target, t.port) {
                c.env(k, v);
            }
            c
        }
        None => {
            // 默认用 cmd.exe；想要 PowerShell 就设环境变量 NIFECODE_SHELL
            let shell = std::env::var("NIFECODE_SHELL")
                .or_else(|_| std::env::var("COMSPEC"))
                .unwrap_or_else(|_| "cmd.exe".into());
            let mut c = CommandBuilder::new(shell);
            if let Some(dir) = cwd {
                c.cwd(dir);
            }
            c
        }
    };
    cmd.env("TERM", "xterm-256color");
    pair.slave.spawn_command(cmd).map_err(|e| format!("启动终端失败：{e}"))?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = st.next.fetch_add(1, Ordering::SeqCst) + 1;

    st.sessions.lock().unwrap().insert(
        id,
        Session { master: pair.master, writer: Arc::new(Mutex::new(writer)) },
    );

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app.emit("pty:data", serde_json::json!({ "id": id, "data": data }));
                }
            }
        }
    });

    Ok(id)
}

#[tauri::command]
pub fn pty_write(st: State<PtyState>, id: u32, data: String) -> Result<(), String> {
    let guard = st.sessions.lock().unwrap();
    let sess = guard.get(&id).ok_or("终端不存在")?;
    let mut w = sess.writer.lock().unwrap();
    w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(st: State<PtyState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    eprintln!("[pty] resize {id} {cols}x{rows}");
    let guard = st.sessions.lock().unwrap();
    let sess = guard.get(&id).ok_or("终端不存在")?;
    sess.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(st: State<PtyState>, id: u32) {
    st.sessions.lock().unwrap().remove(&id);
}
