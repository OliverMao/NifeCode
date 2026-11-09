use base64::Engine;
use serde::Serialize;
use std::process::Command;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

#[derive(Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Serialize)]
pub struct ReadFile {
    pub content: String,
    pub mtime: u64,
}

pub(crate) fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn mtime_ms(m: &std::fs::Metadata) -> u64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// 当前连接用的私钥（可选，-i）；GPU 服务器常需要指定 key
static IDENTITY: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// 断开连接时把常驻通道里的 ssh 进程收掉
#[tauri::command]
pub async fn ssh_close() {
    crate::session::close_all();
}

#[tauri::command]
pub fn ssh_set_identity(key: Option<String>) {
    *IDENTITY.lock().unwrap() = key.filter(|k| !k.trim().is_empty());
}

pub(crate) fn current_identity() -> Option<String> {
    IDENTITY.lock().unwrap().clone()
}

// ---------- 密码：存 Windows 凭据管理器（DPAPI 保护），不落 localStorage ----------
const KEYRING_SERVICE: &str = "dev.nife.code";

fn cred_user(target: &str, port: u16) -> String {
    format!("{target}#{port}")
}

pub(crate) fn lookup_password(target: &str, port: u16) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, &cred_user(target, port))
        .ok()
        .and_then(|e| e.get_password().ok())
}

#[tauri::command]
pub async fn ssh_has_password(target: String, port: u16) -> bool {
    lookup_password(&target, port).is_some()
}

#[tauri::command]
pub async fn ssh_save_password(target: String, port: u16, password: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &cred_user(&target, port))
        .map_err(|e| format!("打开凭据存储失败：{e}"))?;
    if password.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry
        .set_password(&password)
        .map_err(|e| format!("保存密码到 Windows 凭据管理器失败：{e}"))
}

#[tauri::command]
pub async fn ssh_forget_password(target: String, port: u16) {
    if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, &cred_user(&target, port)) {
        let _ = e.delete_credential();
    }
}

/// 有密码就走 SSH_ASKPASS（本程序自己当助手），否则 BatchMode
pub(crate) fn secret_env(target: &str, port: u16) -> Vec<(String, String)> {
    match lookup_password(target, port) {
        None => Vec::new(),
        Some(pw) => {
            let exe = std::env::current_exe()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            vec![
                ("SSH_ASKPASS".into(), exe),
                ("SSH_ASKPASS_REQUIRE".into(), "force".into()),
                ("NIFECODE_ASKPASS".into(), pw),
            ]
        }
    }
}

fn ssh_args(target: &str, port: u16) -> Vec<String> {
    let mut v: Vec<String> = vec![
        "-o".into(), "ConnectTimeout=8".into(),
        "-o".into(), "StrictHostKeyChecking=accept-new".into(),
        // 常驻通道大部分时间是闲着的：靠 keepalive 保活，同时让"对端已经没了"能在 ~15s 内被发现，
        // 而不是让读操作无限期挂着（这是之前界面卡死的根因之一）
        "-o".into(), "ServerAliveInterval=5".into(),
        "-o".into(), "ServerAliveCountMax=3".into(),
        // 密码错了只试一次：默认会连试 3 次密码 + keyboard-interactive，
        // 每次都要重新拉起 askpass，输错密码要等 10 秒才报错
        "-o".into(), "NumberOfPasswordPrompts=1".into(),
    ];
    let has_pw = lookup_password(target, port).is_some();
    if !has_pw {
        v.insert(0, "-o".into());
        v.insert(1, "BatchMode=yes".into());
    } else if current_identity().is_none() {
        // 只存了密码、没配私钥：别再去探测 publickey，省一个往返（2.2s → 1.8s）
        v.push("-o".into());
        v.push("PreferredAuthentications=password,keyboard-interactive".into());
    }
    // Windows 的 OpenSSH 多路复用不稳（实测会 Connection reset by peer），默认关闭；
    // 想试可以设 NIFECODE_MULTIPLEX=1
    if std::env::var("NIFECODE_MULTIPLEX").is_ok() {
        if let Some(dir) = control_dir() {
            let _ = std::fs::create_dir_all(&dir);
            v.push("-o".into());
            v.push("ControlMaster=auto".into());
            v.push("-o".into());
            let sock = dir.join("nifecode-%C");
            // ssh 在 Windows 上对反斜杠路径支持不稳，统一换成正斜杠
            v.push(format!("ControlPath={}", sock.to_string_lossy().replace('\\', "/")));
            v.push("-o".into());
            v.push("ControlPersist=120".into());
        }
    }
    if let Some(key) = current_identity() {
        v.push("-i".into());
        v.push(key);
    }
    v.push("-p".into());
    v.push(port.to_string());
    v
}

fn control_dir() -> Option<std::path::PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    Some(std::path::PathBuf::from(home).join(".ssh"))
}

/// 造一个带好所有参数/环境（私钥、密码 askpass）的 ssh 命令
pub(crate) fn ssh_command(target: &str, port: u16) -> Command {
    let mut command = Command::new("ssh");
    crate::proc::hide_console(&mut command);
    command.args(ssh_args(target, port));
    for (k, v) in secret_env(target, port) {
        command.env(k, v);
    }
    command
}

pub(crate) fn ssh_exec(target: &str, port: u16, cmd: &str) -> Result<Vec<u8>, String> {
    // 优先走常驻通道：一次握手，之后每条命令只花一个往返
    match crate::session::exec(target, port, cmd) {
        Ok((0, out)) => return Ok(out),
        Ok((code, out)) => {
            let msg = String::from_utf8_lossy(&out).trim().to_string();
            return Err(if msg.is_empty() {
                format!("远端命令失败（退出码 {code}）")
            } else {
                msg
            });
        }
        Err(e) => {
            // 认证类错误回落也没用（只会把同样的认证再试一遍，慢一倍，还可能触发 fail2ban）
            let low = e.to_lowercase();
            if low.contains("permission denied")
                || low.contains("authentication failed")
                || low.contains("host key verification failed")
            {
                return Err(e);
            }
            /* 其它原因（比如远端没有 bash）才回落成一次性 ssh */
        }
    }
    let out = ssh_command(target, port)
        .arg(target)
        .arg(cmd)
        .output()
        .map_err(|e| format!("无法启动 ssh 客户端：{e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() { format!("ssh 命令失败：{cmd}") } else { err });
    }
    Ok(out.stdout)
}

fn remote_mtime(host: &str, port: u16, path: &str) -> Result<u64, String> {
    // GNU stat 与 BSD stat 各试一次；远端 mtime 精度为秒
    let cmd = format!(
        "stat -c %Y -- {} 2>/dev/null || stat -f %m {}",
        shq(path),
        shq(path)
    );
    let raw = ssh_exec(host, port, &cmd)?;
    let s = String::from_utf8_lossy(&raw).trim().to_string();
    s.parse::<u64>()
        .map(|secs| secs * 1000)
        .map_err(|_| format!("无法读取修改时间：{path}"))
}

fn sort_entries(v: &mut [Entry]) {
    v.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

#[tauri::command]
pub async fn read_dir(host: Option<String>, port: u16, path: String) -> Result<Vec<Entry>, String> {
    match host {
        None => {
            let mut out = Vec::new();
            for e in std::fs::read_dir(&path).map_err(|e| format!("{path}: {e}"))? {
                let e = match e { Ok(e) => e, Err(_) => continue };
                let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                out.push(Entry {
                    name: e.file_name().to_string_lossy().to_string(),
                    path: e.path().to_string_lossy().replace('\\', "/"),
                    is_dir,
                });
            }
            sort_entries(&mut out);
            Ok(out)
        }
        Some(h) => {
            let raw = ssh_exec(&h, port, &format!("ls -p1A -- {}", shq(&path)))?;
            let base = path.trim_end_matches('/');
            let mut out: Vec<Entry> = String::from_utf8_lossy(&raw)
                .lines()
                .filter(|l| !l.is_empty() && *l != "." && *l != "..")
                .map(|l| {
                    let is_dir = l.ends_with('/');
                    let name = l.trim_end_matches('/').to_string();
                    Entry { path: format!("{base}/{name}"), name, is_dir }
                })
                .collect();
            sort_entries(&mut out);
            Ok(out)
        }
    }
}

#[tauri::command]
pub async fn read_file(host: Option<String>, port: u16, path: String) -> Result<ReadFile, String> {
    match host {
        None => {
            let meta = std::fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?;
            guard_size(meta.len(), &path)?;
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            let content = String::from_utf8(bytes).map_err(|_| "不是 UTF-8 文本文件".to_string())?;
            Ok(ReadFile { content, mtime: mtime_ms(&meta) })
        }
        Some(h) => {
            // 一次 ssh 同时拿：大小 + mtime + 内容（每次 exec 在他们那种 237ms RTT 的链路上一来一回就是 3 秒）
            let q = shq(&path);
            let cmd = format!(
                "f={q}; if [ -r \"$f\" ]; then s=$(wc -c < \"$f\"); y=$(stat -c %Y -- \"$f\" 2>/dev/null || stat -f %m -- \"$f\" 2>/dev/null || echo 0); echo \"M=$s ${{y%% *}}\"; if [ \"$s\" -le {MAX} ]; then base64 -w0 -- \"$f\" 2>/dev/null || base64 \"$f\"; else echo TOOBIG; fi; else echo \"M=ERR 0\"; fi",
                q = q,
                MAX = MAX_OPEN_BYTES
            );
            let raw = ssh_exec(&h, port, &cmd)?;
            let text = String::from_utf8_lossy(&raw).to_string();
            let (size, mtime) = text
                .lines()
                .next()
                .and_then(|l| l.strip_prefix("M="))
                .and_then(|rest| {
                    let mut it = rest.split_whitespace();
                    Some((it.next()?.parse::<u64>().ok()?, it.next()?.parse::<u64>().ok()?))
                })
                .ok_or_else(|| format!("读不到 {} 的信息（文件不存在？）", path))?;
            guard_size(size, &path)?;
            let body = text
                .splitn(2, '\n')
                .nth(1)
                .unwrap_or("")
                .trim_start_matches("TOOBIG")
                .trim();
            let content = match B64.decode(body) {
                Ok(bytes) => String::from_utf8(bytes).map_err(|_| "不是 UTF-8 文本文件".to_string())?,
                Err(_) => body.to_string(),
            };
            Ok(ReadFile { content, mtime: mtime * 1000 })
        }
    }
}

#[tauri::command]
pub async fn write_file(
    host: Option<String>,
    port: u16,
    path: String,
    content: String,
) -> Result<u64, String> {
    match host {
        None => {
            std::fs::write(&path, content.as_bytes()).map_err(|e| format!("{path}: {e}"))?;
            let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
            Ok(mtime_ms(&meta))
        }
        Some(h) => {
            // 内容 base64 后跟命令一起走常驻通道，不再单开一个 ssh + stdin 管道
            let q = shq(&path);
            let payload = crate::session::b64_encode(content.as_bytes());
            let cmd = format!(
                "printf '%s' '{payload}' | base64 -d > {q} && (stat -c %Y -- {q} 2>/dev/null || stat -f %m -- {q} 2>/dev/null || echo 0)"
            );
            let out = ssh_exec(&h, port, &cmd)?;
            Ok(String::from_utf8_lossy(&out)
                .trim()
                .parse::<u64>()
                .unwrap_or(0)
                * 1000)
        }
    }
}

/// 一次拿多个文件的 mtime（轮询外部改动用），远端只跑一条命令
#[tauri::command]
pub async fn stat_files(host: Option<String>, port: u16, paths: Vec<String>) -> Result<Vec<u64>, String> {
    match host {
        None => Ok(paths
            .iter()
            .map(|p| std::fs::metadata(p).map(|m| mtime_ms(&m)).unwrap_or(0))
            .collect()),
        Some(h) => {
            if paths.is_empty() {
                return Ok(Vec::new());
            }
            let list: Vec<String> = paths.iter().map(|p| shq(p)).collect();
            let cmd = format!(
                "stat -c '%Y %n' -- {} 2>/dev/null || stat -f '%m %N' -- {} 2>/dev/null || true",
                list.join(" "),
                list.join(" ")
            );
            let raw = ssh_exec(&h, port, &cmd)?;
            let mut map: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
            for line in String::from_utf8_lossy(&raw).lines() {
                if let Some((secs, name)) = line.trim().split_once(' ') {
                    if let Ok(s) = secs.parse::<u64>() {
                        map.insert(name.trim().to_string(), s * 1000);
                    }
                }
            }
            Ok(paths.iter().map(|p| *map.get(p).unwrap_or(&0)).collect())
        }
    }
}

#[tauri::command]
pub async fn stat_file(host: Option<String>, port: u16, path: String) -> Result<u64, String> {
    match host {
        None => std::fs::metadata(&path)
            .map(|m| mtime_ms(&m))
            .map_err(|e| format!("{path}: {e}")),
        Some(h) => remote_mtime(&h, port, &path),
    }
}

#[tauri::command]
pub fn pick_folder() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("打开文件夹")
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn ssh_home(target: String, port: u16) -> Result<String, String> {
    let raw = ssh_exec(&target, port, "echo $HOME")?;
    let home = String::from_utf8_lossy(&raw).trim().to_string();
    if home.is_empty() {
        return Err(format!("无法获取 {target} 的 HOME 目录"));
    }
    Ok(home)
}

// ---------- 全项目搜索 ----------

#[derive(Serialize)]
pub struct SearchHit {
    pub path: String,
    pub line: u32,
    pub text: String,
}

const MAX_OPEN_BYTES: u64 = 8 * 1024 * 1024;

fn guard_size(size: u64, path: &str) -> Result<(), String> {
    if size > MAX_OPEN_BYTES {
        return Err(format!(
            "文件 {} MB，超过 8MB 上限，暂不打开（{}）",
            size / 1024 / 1024,
            path
        ));
    }
    Ok(())
}

const SKIP_DIRS: [&str; 9] = [".git", "node_modules", "target", "dist", "build", ".venv", "__pycache__", ".idea", ".next"];

fn walk_search(root: &std::path::Path, query: &str, max: usize, out: &mut Vec<SearchHit>) {
    if out.len() >= max {
        return;
    }
    let Ok(rd) = std::fs::read_dir(root) else { return };
    for e in rd.flatten() {
        if out.len() >= max {
            return;
        }
        let path = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk_search(&path, query, max, out);
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        if meta.len() > 2 * 1024 * 1024 {
            continue; // shortcut: 搜索跳过 2MB 以上的文件
        }
        let Ok(bytes) = std::fs::read(&path) else { continue };
        if bytes.iter().take(4096).any(|&b| b == 0) {
            continue; // 二进制
        }
        let Ok(text) = String::from_utf8(bytes) else { continue };
        for (i, line) in text.lines().enumerate() {
            if line.contains(query) {
                out.push(SearchHit {
                    path: path.to_string_lossy().replace('\\', "/"),
                    line: (i + 1) as u32,
                    text: line.trim().chars().take(200).collect(),
                });
                if out.len() >= max {
                    return;
                }
            }
        }
    }
}

/// 本地走进程内遍历；远端跑一条 grep（GPU 服务器上肯定有 grep）
#[tauri::command]
pub async fn search(
    host: Option<String>,
    port: u16,
    cwd: String,
    query: String,
    max: usize,
) -> Result<Vec<SearchHit>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let max = max.clamp(1, 500);
    match host {
        None => {
            let mut out = Vec::new();
            walk_search(std::path::Path::new(&cwd), &query, max, &mut out);
            Ok(out)
        }
        Some(h) => {
            let cmd = format!(
                "cd {} && grep -rnI --binary-files=without-match --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=__pycache__ --exclude-dir=.venv -m 30 -- {} . | head -{}",
                shq(&cwd),
                shq(&query),
                max
            );
            let raw = ssh_exec(&h, port, &cmd).unwrap_or_default();
            let text = String::from_utf8_lossy(&raw);
            let mut out = Vec::new();
            for line in text.lines() {
                // 形如 ./a/b.py:12:代码
                let mut it = line.splitn(3, ':');
                let (Some(p), Some(n), Some(body)) = (it.next(), it.next(), it.next()) else { continue };
                let Ok(lineno) = n.parse::<u32>() else { continue };
                let rel = p.strip_prefix("./").unwrap_or(p);
                out.push(SearchHit {
                    path: format!("{}/{}", cwd.trim_end_matches('/'), rel),
                    line: lineno,
                    text: body.trim().chars().take(200).collect(),
                });
            }
            Ok(out)
        }
    }
}

// ---------- 文件操作（新建 / 重命名 / 删除 / 复制）----------

/// 防手滑：不允许对空路径、根目录动手
fn check_target(path: &str) -> Result<(), String> {
    let p = path.trim();
    if p.is_empty() || p == "/" || p.len() == 2 && p.ends_with(':') {
        return Err("不能对根目录执行这个操作".into());
    }
    Ok(())
}

fn remote_fail(out: &[u8]) -> Option<String> {
    let msg = String::from_utf8_lossy(out).trim().to_string();
    if msg.is_empty() { None } else { Some(msg) }
}

#[tauri::command]
pub async fn fs_new(host: Option<String>, port: u16, path: String, dir: bool) -> Result<(), String> {
    check_target(&path)?;
    match host {
        None => {
            let p = std::path::Path::new(&path);
            if p.exists() {
                return Err("已经存在同名文件".into());
            }
            if dir {
                std::fs::create_dir_all(p).map_err(|e| format!("{path}: {e}"))
            } else {
                if let Some(parent) = p.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                std::fs::File::create(p).map(|_| ()).map_err(|e| format!("{path}: {e}"))
            }
        }
        Some(h) => {
            let q = shq(&path);
            let cmd = if dir {
                format!("[ -e {q} ] && {{ echo 已经存在同名文件; exit 7; }}; mkdir -p {q}")
            } else {
                format!("[ -e {q} ] && {{ echo 已经存在同名文件; exit 7; }}; mkdir -p \"$(dirname {q})\" && : > {q}")
            };
            ssh_exec(&h, port, &cmd).map(|_| ()).map_err(|e| remote_fail(e.as_bytes()).unwrap_or(e))
        }
    }
}

#[tauri::command]
pub async fn fs_rename(host: Option<String>, port: u16, from: String, to: String) -> Result<(), String> {
    check_target(&from)?;
    check_target(&to)?;
    match host {
        None => {
            let dst = std::path::Path::new(&to);
            if dst.exists() {
                return Err("目标已存在".into());
            }
            std::fs::rename(&from, &to).map_err(|e| format!("{from} → {to}: {e}"))
        }
        Some(h) => {
            let cmd = format!(
                "[ -e {t} ] && {{ echo 目标已存在; exit 7; }}; mv -- {f} {t}",
                f = shq(&from),
                t = shq(&to)
            );
            ssh_exec(&h, port, &cmd).map(|_| ()).map_err(|e| remote_fail(e.as_bytes()).unwrap_or(e))
        }
    }
}

#[tauri::command]
pub async fn fs_delete(host: Option<String>, port: u16, path: String) -> Result<(), String> {
    check_target(&path)?;
    match host {
        None => {
            let p = std::path::Path::new(&path);
            let r = if p.is_dir() { std::fs::remove_dir_all(p) } else { std::fs::remove_file(p) };
            r.map_err(|e| format!("{path}: {e}"))
        }
        Some(h) => {
            let cmd = format!("rm -rf -- {}", shq(&path));
            ssh_exec(&h, port, &cmd).map(|_| ()).map_err(|e| remote_fail(e.as_bytes()).unwrap_or(e))
        }
    }
}

#[tauri::command]
pub async fn fs_copy(host: Option<String>, port: u16, from: String, to: String) -> Result<(), String> {
    check_target(&from)?;
    check_target(&to)?;
    match host {
        None => {
            let dst = std::path::Path::new(&to);
            if dst.exists() {
                return Err("目标已存在".into());
            }
            copy_recursive(std::path::Path::new(&from), dst).map_err(|e| format!("{from} → {to}: {e}"))
        }
        Some(h) => {
            let cmd = format!(
                "[ -e {t} ] && {{ echo 目标已存在; exit 7; }}; cp -r -- {f} {t}",
                f = shq(&from),
                t = shq(&to)
            );
            ssh_exec(&h, port, &cmd).map(|_| ()).map_err(|e| remote_fail(e.as_bytes()).unwrap_or(e))
        }
    }
}

fn copy_recursive(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        for e in std::fs::read_dir(from)? {
            let e = e?;
            copy_recursive(&e.path(), &to.join(e.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(from, to).map(|_| ())
    }
}
