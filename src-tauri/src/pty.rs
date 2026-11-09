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

#[derive(serde::Serialize, Clone)]
pub struct ShellInfo {
    pub id: String,
    pub name: String,
    pub exe: String,
    pub args: Vec<String>,
}

fn which(exe: &str) -> Option<String> {
    let paths = std::env::var("PATH").unwrap_or_default();
    for dir in paths.split(';') {
        if dir.trim().is_empty() {
            continue;
        }
        let p = std::path::Path::new(dir).join(exe);
        if p.is_file() {
            return Some(p.to_string_lossy().to_string());
        }
    }
    None
}

/// 列出这台机器上能用的终端（PowerShell 7 / Windows PowerShell / cmd / Git Bash / WSL）
pub fn detect_shells() -> Vec<ShellInfo> {
    let mut v: Vec<ShellInfo> = Vec::new();
    if let Some(p) = which("pwsh.exe") {
        v.push(ShellInfo { id: "pwsh".into(), name: "PowerShell 7".into(), exe: p, args: vec![] });
    }
    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let ps = format!(r"{sysroot}\System32\WindowsPowerShell\v1.0\powershell.exe");
    if std::path::Path::new(&ps).is_file() {
        v.push(ShellInfo { id: "powershell".into(), name: "Windows PowerShell".into(), exe: ps, args: vec![] });
    }
    if let Ok(c) = std::env::var("COMSPEC") {
        v.push(ShellInfo { id: "cmd".into(), name: "命令提示符 (cmd)".into(), exe: c, args: vec![] });
    }
    for p in [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
    ] {
        if std::path::Path::new(p).is_file() {
            v.push(ShellInfo {
                id: "gitbash".into(),
                name: "Git Bash".into(),
                exe: p.into(),
                args: vec!["--login".into(), "-i".into()],
            });
            break;
        }
    }
    // 便携版 / 非标准安装位置：从 PATH 里的 git.exe 反推 <root>\bin\bash.exe
    if !v.iter().any(|s| s.id == "gitbash") {
        let mut cands: Vec<String> = Vec::new();
        if let Some(git) = which("git.exe") {
            if let Some(root) = std::path::Path::new(&git).parent().and_then(|p| p.parent()) {
                cands.push(root.join("bin").join("bash.exe").to_string_lossy().to_string());
            }
        }
        if let Some(b) = which("bash.exe") {
            cands.push(b);
        }
        for p in cands {
            if std::path::Path::new(&p).is_file() {
                v.push(ShellInfo {
                    id: "gitbash".into(),
                    name: "Git Bash".into(),
                    exe: p,
                    args: vec!["--login".into(), "-i".into()],
                });
                break;
            }
        }
    }
    // wsl -l -q 的输出是 UTF-16LE
    if which("wsl.exe").is_some() {
        let mut c = std::process::Command::new("wsl.exe");
        c.args(["-l", "-q"]);
        crate::proc::hide_console(&mut c);
        if let Ok(o) = c.output() {
            let bytes = o.stdout;
            let mut u16s = Vec::with_capacity(bytes.len() / 2);
            for pair in bytes.chunks_exact(2) {
                u16s.push(u16::from_le_bytes([pair[0], pair[1]]));
            }
            for line in String::from_utf16_lossy(&u16s).lines() {
                let name = line.trim().trim_matches('\u{feff}').to_string();
                if name.is_empty() || name.starts_with("Windows") {
                    continue;
                }
                v.push(ShellInfo {
                    id: format!("wsl:{name}"),
                    name: format!("WSL · {name}"),
                    exe: "wsl.exe".into(),
                    args: vec!["-d".into(), name],
                });
            }
        }
    }
    v
}

#[tauri::command]
pub fn shells() -> Vec<ShellInfo> {
    detect_shells()
}

#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    st: State<PtyState>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    ssh: Option<SshTarget>,
    shell: Option<String>,
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
            // 没指定就用检测到的第一个（PowerShell 优先），和 VS Code 的默认终端一个思路
            let list = detect_shells();
            let chosen = shell
                .as_ref()
                .and_then(|id| list.iter().find(|s| &s.id == id))
                .or_else(|| list.first());
            match chosen {
                Some(s) => {
                    let mut c = CommandBuilder::new(&s.exe);
                    for a in &s.args {
                        c.arg(a);
                    }
                    // cwd 统一给 Windows 路径：wsl.exe 自己会翻译成 /mnt/...
                    if let Some(dir) = cwd {
                        c.cwd(dir);
                    }
                    c
                }
                None => CommandBuilder::new("cmd.exe"),
            }
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
    // 排查输入法/输入时序用：NIFECODE_PTY_DEBUG=1 时把每次写入打出来
    if std::env::var_os("NIFECODE_PTY_DEBUG").is_some() {
        eprintln!("[pty] write {id} {:?}", data);
    }
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
