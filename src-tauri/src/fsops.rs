// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 OliverMao — NifeCode, 见仓库根目录 LICENSE
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
    pub encoding: String, // 猜出来的编码，保存时按它写回去
    pub huge: bool,       // 大于 8MB：前端以只读方式打开
    pub binary: bool,     // 看起来是二进制：前端要像 VS Code 那样问一句"仍然打开吗"
}

/// 像不像二进制：开头 8KB 里有 NUL，或者控制字符超过 10%（GBK/UTF-8 的高位字节不算）
pub(crate) fn looks_binary(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(8192)];
    if head.contains(&0) {
        return true;
    }
    let bad = head
        .iter()
        .filter(|b| **b < 0x09 || (**b > 0x0d && **b < 0x20) || **b == 0x7f)
        .count();
    !head.is_empty() && bad * 10 > head.len()
}

/// 文本解码。forced 是用户手动指定的编码（重新打开时用）
pub(crate) fn decode_bytes(bytes: &[u8], forced: Option<&str>) -> (String, String) {
    // 先看 BOM，这个最权威
    if forced.is_none() {
        if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
            return (String::from_utf8_lossy(&bytes[3..]).to_string(), "utf-8".into());
        }
        if bytes.starts_with(&[0xFF, 0xFE]) {
            let (s, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
            return (s.to_string(), "utf-16le".into());
        }
        if bytes.starts_with(&[0xFE, 0xFF]) {
            let (s, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
            return (s.to_string(), "utf-16be".into());
        }
    }
    if let Some(label) = forced {
        let enc = encoding_rs::Encoding::for_label(label.as_bytes()).unwrap_or(encoding_rs::UTF_8);
        let (s, _, _) = enc.decode(bytes);
        return (s.to_string(), enc.name().to_lowercase());
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return (s.to_string(), "utf-8".into());
    }
    // 不是合法 UTF-8：中文 Windows 上基本都是 GBK（GB18030 超集，顺手也认了）
    let (s, _, gbk_bad) = encoding_rs::GBK.decode(bytes);
    if !gbk_bad {
        return (s.to_string(), "gbk".into());
    }
    (String::from_utf8_lossy(bytes).to_string(), "utf-8".into())
}

pub(crate) fn encode_text(text: &str, encoding: &str) -> Result<Vec<u8>, String> {
    match encoding {
        "gbk" => {
            let (bytes, _, bad) = encoding_rs::GBK.encode(text);
            if bad {
                return Err("内容里有 GBK 表示不了的字符（用 UTF-8 保存吧）".into());
            }
            Ok(bytes.into_owned())
        }
        "utf-16le" => {
            let mut out = vec![0xFF, 0xFE];
            for u in text.encode_utf16() {
                out.extend_from_slice(&u.to_le_bytes());
            }
            Ok(out)
        }
        "utf-16be" => {
            let mut out = vec![0xFE, 0xFF];
            for u in text.encode_utf16() {
                out.extend_from_slice(&u.to_be_bytes());
            }
            Ok(out)
        }
        _ => Ok(text.as_bytes().to_vec()),
    }
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

// 每台机器用的私钥（可选，-i）。必须按「主机+端口」分开存：
// 同一个 IP 不同端口可能是两台机器（端口转发），各自一把 key，共用一个全局值就会拿错钥匙
static IDENTITY: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, String>>> =
    std::sync::OnceLock::new();

fn identities() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    IDENTITY.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn ident_key(target: &str, port: u16) -> String {
    format!("{}:{}", target.to_lowercase(), port)
}

/// 断开连接时把常驻通道里的 ssh 进程收掉
#[tauri::command]
pub async fn ssh_close() {
    crate::session::close_all();
}

#[tauri::command]
pub fn ssh_set_identity(target: String, port: u16, key: Option<String>) {
    let slot = ident_key(&target, port);
    let mut g = identities().lock().unwrap();
    match key.filter(|k| !k.trim().is_empty()) {
        Some(k) => {
            g.insert(slot, k);
        }
        None => {
            g.remove(&slot);
        }
    }
}

pub(crate) fn current_identity(target: &str, port: u16) -> Option<String> {
    identities().lock().unwrap().get(&ident_key(target, port)).cloned()
}

/// NifeCode 自己的 known_hosts。不跟系统 %USERPROFILE%\.ssh\known_hosts 混用：
/// 系统那份被 Xshell / git / 其它终端共用，任一边改一条都会波及另一边
fn our_known_hosts() -> Option<std::path::PathBuf> {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok()?;
    Some(std::path::PathBuf::from(home).join(".ssh").join("nifecode_known_hosts"))
}

/// 这条记录在 known_hosts 里的名字：22 端口写 host，其它端口写 [host]:port（跟 ssh 自己的写法一致）
fn host_alias(target: &str, port: u16) -> String {
    if port == 22 {
        target.to_string()
    } else {
        format!("[{target}]:{port}")
    }
}

/// 指纹相关的 ssh 参数。执行通道 / 终端 / 端口转发三处都要带上，
/// 否则同一个主机在不同通道里各存一份指纹、互相看不见
pub(crate) fn known_host_args(target: &str, port: u16) -> Vec<String> {
    let Some(kh) = our_known_hosts() else { return Vec::new() };
    if let Some(dir) = kh.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    vec![
        "-o".into(),
        format!("UserKnownHostsFile={}", kh.to_string_lossy().replace('\\', "/")),
        "-o".into(),
        // 同名 IP 换端口/换机器也能连：指纹按「主机:端口」分开存
        format!("HostKeyAlias={}", host_alias(target, port)),
        "-o".into(),
        // 再按 IP 存一条会跟「同 IP 不同端口的另一台机器」撞车
        "CheckHostIP=no".into(),
    ]
}

/// 删掉我们自己 known_hosts 里 host:port 那一条（机器重装、同 IP 换了端口/机器时，
/// ssh 会报 "REMOTE HOST IDENTIFICATION HAS CHANGED" 直接拒绝连接）
#[tauri::command]
pub fn ssh_forget_host(target: String, port: u16) -> Result<(), String> {
    let kh = our_known_hosts().ok_or("找不到 HOME 目录")?;
    if !kh.exists() {
        return Ok(()); // 没有记录，本来就不该冲突
    }
    let mut c = Command::new("ssh-keygen");
    crate::proc::hide_console(&mut c);
    // -R 既能删明文条目，也能删 hashed 条目（HashKnownHosts 开着时）
    let out = c
        .arg("-R")
        .arg(host_alias(&target, port))
        .arg("-f")
        .arg(&kh)
        .output()
        .map_err(|e| format!("调不到 ssh-keygen：{e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
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
    v.extend(known_host_args(target, port));
    let has_pw = lookup_password(target, port).is_some();
    if !has_pw {
        v.insert(0, "-o".into());
        v.insert(1, "BatchMode=yes".into());
    } else if current_identity(target, port).is_none() {
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
    if let Some(key) = current_identity(target, port) {
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
pub async fn read_file(
    host: Option<String>,
    port: u16,
    path: String,
    encoding: Option<String>,
) -> Result<ReadFile, String> {
    match host {
        None => {
            let meta = std::fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?;
            let huge = guard_size(meta.len(), &path)?;
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            let (content, encoding) = decode_bytes(&bytes, encoding.as_deref());
            // 带 BOM 的 UTF-16 里天然有 NUL，别误判成二进制
            let binary = !encoding.starts_with("utf-16") && looks_binary(&bytes);
            Ok(ReadFile { content, mtime: mtime_ms(&meta), encoding, huge, binary })
        }
        Some(h) => {
            // 一次 ssh 同时拿：大小 + mtime + 内容（每次 exec 在他们那种 237ms RTT 的链路上一来一回就是 3 秒）
            let q = shq(&path);
            let cmd = format!(
                "f={q}; if [ -r \"$f\" ]; then s=$(wc -c < \"$f\"); y=$(stat -c %Y -- \"$f\" 2>/dev/null || stat -f %m -- \"$f\" 2>/dev/null || echo 0); echo \"M=$s ${{y%% *}}\"; if [ \"$s\" -le {MAX} ]; then base64 -w0 -- \"$f\" 2>/dev/null || base64 \"$f\"; else echo TOOBIG; fi; else echo \"M=ERR 0\"; fi",
                q = q,
                MAX = HARD_MAX_BYTES
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
            let huge = guard_size(size, &path)?;
            let body = text
                .splitn(2, '\n')
                .nth(1)
                .unwrap_or("")
                .trim_start_matches("TOOBIG")
                .trim();
            let bytes = B64.decode(body).ok();
            let (content, encoding) = match &bytes {
                Some(b) => decode_bytes(b, encoding.as_deref()),
                None => (body.to_string(), "utf-8".into()),
            };
            let binary = !encoding.starts_with("utf-16") && bytes.as_deref().is_some_and(looks_binary);
            Ok(ReadFile { content, mtime: mtime * 1000, encoding, huge, binary })
        }
    }
}

/// explorer.exe / start 只认反斜杠：喂 `D:/a/b` 它当无效路径，直接打开"此电脑"或用户目录
#[cfg(windows)]
fn win_native(path: &str) -> String {
    path.replace('/', "\\")
}

/// 用系统默认程序打开（本机才有）
#[tauri::command]
pub fn fs_open(path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Err(format!("路径不存在：{path}"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &win_native(&path)])
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open").arg(&path).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn write_file(
    host: Option<String>,
    port: u16,
    path: String,
    content: String,
    encoding: String,
) -> Result<u64, String> {
    // 按打开时的编码写回去：GBK 文件写成 UTF-8 会把别人的工具搞乱
    let bytes = encode_text(&content, &encoding)?;
    match host {
        None => {
            std::fs::write(&path, &bytes).map_err(|e| format!("{path}: {e}"))?;
            let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
            Ok(mtime_ms(&meta))
        }
        Some(h) => {
            // 内容 base64 后跟命令一起走常驻通道，不再单开一个 ssh + stdin 管道
            let q = shq(&path);
            let payload = crate::session::b64_encode(&bytes);
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

/// 本机用户目录（选文件夹弹窗的起始位置；Windows 上就是 %USERPROFILE%）
#[tauri::command]
pub fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(|h| h.replace('\\', "/"))
}

/// 在 Windows 资源管理器里定位/打开（远端没有这个能力，前端会隐藏菜单项）
#[tauri::command]
pub fn fs_reveal(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("路径不存在：{path}"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let native = win_native(&path);
        let mut cmd = std::process::Command::new("explorer.exe");
        if p.is_dir() {
            cmd.arg(&native);
        } else {
            // /select, 和路径必须连在一起，参数里的空格交给系统解析
            cmd.raw_arg(format!("/select,\"{native}\""));
        }
        crate::proc::hide_console(&mut cmd);
        // explorer.exe 总是返回非 0，能启动就算成功
        cmd.spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("只有 Windows 支持".into())
    }
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
/// 超过这个就不开了，硬上限
const HARD_MAX_BYTES: u64 = 96 * 1024 * 1024;

fn guard_size(size: u64, path: &str) -> Result<bool, String> {
    if size > HARD_MAX_BYTES {
        return Err(format!(
            "文件 {} MB，超过 {}MB 硬上限，不开（{}）",
            size / 1024 / 1024,
            HARD_MAX_BYTES / 1024 / 1024,
            path
        ));
    }
    // 大于 8MB 还是给开，但标记一下，前端用只读方式打开
    Ok(size > MAX_OPEN_BYTES)
}

const SKIP_DIRS: [&str; 9] = [".git", "node_modules", "target", "dist", "build", ".venv", "__pycache__", ".idea", ".next"];

/// 在原始字节里找子串（先扫首字节，避免每个位置都 memcmp）
fn has_bytes(hay: &[u8], needle: &[u8]) -> bool {
    let Some((&first, rest)) = needle.split_first() else { return false };
    if hay.len() < needle.len() {
        return false;
    }
    let mut i = 0;
    while let Some(p) = hay[i..].iter().position(|&b| b == first) {
        let at = i + p;
        let end = at + needle.len();
        if end > hay.len() {
            return false;
        }
        if &hay[at + 1..end] == rest {
            return true;
        }
        i = at + 1;
    }
    false
}

/// 本地递归：走 ignore 的遍历器，.gitignore / .ignore / git 全局忽略统统生效（跟 ripgrep 一个引擎）
fn walker(root: &std::path::Path) -> impl Iterator<Item = ignore::DirEntry> {
    ignore::WalkBuilder::new(root)
        .hidden(false) // .github / .vscode 这类还是要能搜到
        .require_git(false) // 不是 git 仓库的目录也认 .gitignore
        .sort_by_file_name(|a, b| a.cmp(b))
        .build()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
}

fn walk_search(root: &std::path::Path, query: &str, max: usize, out: &mut Vec<SearchHit>) {
    let needle = query.as_bytes();
    for e in walker(root) {
        if out.len() >= max {
            return;
        }
        let Ok(meta) = e.metadata() else { continue };
        if meta.len() > 2 * 1024 * 1024 {
            continue; // shortcut: 搜索跳过 2MB 以上的文件
        }
        let Ok(bytes) = std::fs::read(e.path()) else { continue };
        if bytes.iter().take(4096).any(|&b| b == 0) {
            continue; // 二进制
        }
        // 先在原始字节里找一遍：没命中就不做编码探测和解码（大仓里绝大多数文件都是这一支）
        if !has_bytes(&bytes, needle) {
            continue;
        }
        let (text, _) = decode_bytes(&bytes, None);
        for (i, line) in text.lines().enumerate() {
            if line.contains(query) {
                out.push(SearchHit {
                    path: e.path().to_string_lossy().replace('\\', "/"),
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

/// 把本地文件里的 query 换成 replacement，返回动过的文件（相对路径）
fn walk_replace(root: &std::path::Path, query: &str, to: &str, max: usize) -> Vec<String> {
    let mut changed = Vec::new();
    let needle = query.as_bytes();
    for e in walker(root) {
        if changed.len() >= max {
            break;
        }
        let Ok(meta) = e.metadata() else { continue };
        if meta.len() > 2 * 1024 * 1024 {
            continue;
        }
        let Ok(bytes) = std::fs::read(e.path()) else { continue };
        if bytes.iter().take(4096).any(|&b| b == 0) {
            continue;
        }
        if !has_bytes(&bytes, needle) {
            continue;
        }
        let (text, enc) = decode_bytes(&bytes, None);
        if !text.contains(query) {
            continue;
        }
        let next = text.replace(query, to);
        let Ok(out) = encode_text(&next, &enc) else { continue };
        if std::fs::write(e.path(), out).is_ok() {
            if let Ok(rel) = e.path().strip_prefix(root) {
                changed.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    changed
}

/// 快速打开（Ctrl+P）用的文件清单，返回相对工作区的路径
#[tauri::command]
pub async fn list_files(
    host: Option<String>,
    port: u16,
    root: String,
    max: usize,
) -> Result<Vec<String>, String> {
    let max = max.clamp(100, 50000);
    match host {
        None => {
            let base = std::path::PathBuf::from(&root);
            let mut out: Vec<String> = walker(&base)
                .filter_map(|e| e.path().strip_prefix(&base).ok().map(|r| r.to_string_lossy().replace('\\', "/")))
                .take(max)
                .collect();
            out.sort();
            Ok(out)
        }
        Some(h) => {
            // 远端优先用 git（自带 .gitignore 生效），不是仓库就退回 find
            let git = format!(
                "cd {r} && git ls-files -z -co --exclude-standard 2>/dev/null | tr '\\0' '\\n' | head -n {max}",
                r = shq(&root),
                max = max
            );
            let mut out = ssh_exec(&h, port, &git)?;
            let mut lines: Vec<String> = String::from_utf8_lossy(&out)
                .lines()
                .map(|l| l.trim_end_matches('\r').to_string())
                .filter(|l| !l.is_empty())
                .collect();
            if lines.is_empty() {
                let mut cmd = format!("cd {} && find . -type f", shq(&root));
                for d in SKIP_DIRS {
                    cmd.push_str(&format!(" -not -path '*/{d}/*'"));
                }
                cmd.push_str(&format!(" | head -n {max} | sed 's|^\\./||'"));
                out = ssh_exec(&h, port, &cmd)?;
                lines = String::from_utf8_lossy(&out)
                    .lines()
                    .map(|l| l.trim_end_matches('\r').to_string())
                    .filter(|l| !l.is_empty())
                    .collect();
            }
            Ok(lines)
        }
    }
}

const SKIP_REPO_DIRS: [&str; 8] = [".git", "node_modules", "target", "dist", "build", "vendor", ".venv", "__pycache__"];

fn walk_repos(dir: &std::path::Path, rel: &str, depth: u32, max_depth: u32, budget: &mut i32, out: &mut Vec<String>) {
    if *budget <= 0 {
        return;
    }
    *budget -= 1;
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut subs: Vec<(String, std::path::PathBuf)> = Vec::new();
    let mut is_repo = false;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name == ".git" {
            is_repo = true;
            continue;
        }
        if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            subs.push((name, e.path()));
        }
    }
    if is_repo {
        out.push(rel.to_string());
    }
    if depth >= max_depth {
        return;
    }
    for (name, path) in subs {
        if name.starts_with('.') || SKIP_REPO_DIRS.contains(&name.as_str()) {
            continue;
        }
        let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        walk_repos(&path, &child, depth + 1, max_depth, budget, out);
    }
}

/// 找 git 仓库（SCM 面板的下拉框）：本地在进程内遍历，远端一条 find 搞定
///
/// 以前是前端递归 read_dir：每个目录一次 IPC / 一次 ssh 往返，300 个目录在 237ms RTT 上要几分钟
#[tauri::command]
pub async fn find_repos(host: Option<String>, port: u16, root: String, depth: u32) -> Result<Vec<String>, String> {
    let depth = depth.clamp(1, 3);
    match host {
        None => {
            let mut out = Vec::new();
            let mut budget = 300i32;
            walk_repos(std::path::Path::new(&root), "", 0, depth, &mut budget, &mut out);
            Ok(out)
        }
        Some(h) => {
            let cmd = format!(
                "cd {} && find . -maxdepth {} -name .git -prune -print 2>/dev/null | head -100",
                shq(&root),
                depth
            );
            let raw = ssh_exec(&h, port, &cmd)?;
            let mut out = Vec::new();
            for line in String::from_utf8_lossy(&raw).lines() {
                // 形如 ./sub/.git 或 ./.git
                let Some(dir) = line.trim().strip_suffix("/.git") else { continue };
                let rel = dir.strip_prefix("./").unwrap_or(dir);
                out.push(if rel == "." { String::new() } else { rel.to_string() });
            }
            Ok(out)
        }
    }
}

/// 图片预览：把文件原样 base64 回给前端（本地读盘 / 远端也是一次命令）
#[tauri::command]
pub async fn read_binary(host: Option<String>, port: u16, path: String) -> Result<String, String> {
    const LIMIT: u64 = 32 * 1024 * 1024;
    match host {
        None => {
            let meta = std::fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?;
            if meta.len() > LIMIT {
                return Err(format!("{} MB，超过 32MB 预览上限", meta.len() / 1024 / 1024));
            }
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            Ok(B64.encode(bytes))
        }
        Some(h) => {
            let cmd = format!(
                "f={}; s=$(wc -c < \"$f\") || exit 1; if [ \"$s\" -gt {LIMIT} ]; then echo TOOBIG; else base64 -w0 -- \"$f\" 2>/dev/null || base64 \"$f\"; fi",
                shq(&path)
            );
            let raw = ssh_exec(&h, port, &cmd)?;
            let text = String::from_utf8_lossy(&raw).trim().to_string();
            if text == "TOOBIG" {
                return Err("超过 32MB 预览上限".into());
            }
            Ok(text.replace(['\n', '\r'], ""))
        }
    }
}

/// 全项目替换，返回动过的文件（相对路径）
#[tauri::command]
pub async fn replace_all(
    host: Option<String>,
    port: u16,
    cwd: String,
    query: String,
    replacement: String,
    max: usize,
) -> Result<Vec<String>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let max = max.clamp(1, 200);
    match host {
        None => Ok(walk_replace(std::path::Path::new(&cwd), &query, &replacement, max)),
        Some(h) => {
            // 远端：先找命中文件，再逐个 base64 拉回来改完写回（最多 50 个，多了太慢）
            let cmd = format!(
                "cd {} && grep -rlI --binary-files=without-match --exclude-dir=.git -- {} . | head -50 | sed 's|^\\./||'",
                shq(&cwd),
                shq(&query)
            );
            let raw = ssh_exec(&h, port, &cmd)?;
            let mut changed = Vec::new();
            for rel in String::from_utf8_lossy(&raw).lines().map(|l| l.trim()).filter(|l| !l.is_empty()) {
                let abs = format!("{}/{}", cwd.trim_end_matches('/'), rel);
                let file = read_file(Some(h.clone()), port, abs.clone(), None).await?;
                if !file.content.contains(&query) {
                    continue;
                }
                let next = file.content.replace(&query, &replacement);
                write_file(Some(h.clone()), port, abs, next, file.encoding).await?;
                changed.push(rel.to_string());
            }
            Ok(changed)
        }
    }
}

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
            // 全仓扫描是纯 CPU + 阻塞 IO：直接跑在 async 里会占死一个 tokio worker，
            // 同时刻的 pty_write（终端输入）、stat_files（文件树轮询）都得排队
            tauri::async_runtime::spawn_blocking(move || {
                let mut out = Vec::new();
                walk_search(std::path::Path::new(&cwd), &query, max, &mut out);
                out
            })
            .await
            .map_err(|e| e.to_string())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_alias_is_per_port() {
        // 22 端口保持原样（跟 ssh 自己的写法一致），其它端口带方括号端口
        assert_eq!(host_alias("10.0.0.1", 22), "10.0.0.1");
        assert_eq!(host_alias("10.0.0.1", 2222), "[10.0.0.1]:2222");
        // 同一个 IP 不同端口必须是两条不同的记录，否则指纹会互相顶掉
        assert_ne!(host_alias("10.0.0.1", 22), host_alias("10.0.0.1", 2222));
        assert_ne!(host_alias("10.0.0.1", 2222), host_alias("10.0.0.1", 2223));
    }

    #[test]
    fn known_host_args_point_at_our_own_file() {
        let args = known_host_args("example.com", 2222);
        let joined = args.join(" ");
        // 路径里不能有反斜杠：ssh 在 Windows 上对反斜杠支持不稳
        let kh = joined
            .split(' ')
            .find(|a| a.starts_with("UserKnownHostsFile="))
            .expect("缺少 UserKnownHostsFile");
        assert!(kh.ends_with("nifecode_known_hosts"), "{kh}");
        assert!(!kh.contains('\\'), "{kh}");
        // 指纹按 host:port 分开存，并且不再按 IP 记第二条
        assert!(joined.contains("HostKeyAlias=[example.com]:2222"), "{joined}");
        assert!(joined.contains("CheckHostIP=no"), "{joined}");
    }
}

#[cfg(test)]
mod perf_tests {
    use super::{has_bytes, walk_repos};

    #[test]
    fn has_bytes_boundaries() {
        assert!(has_bytes(b"hello world", b"world"));
        assert!(has_bytes(b"aaa", b"a"));
        assert!(has_bytes(b"xxab", b"ab")); // 命中贴着尾部
        assert!(!has_bytes(b"hello", b"world"));
        assert!(!has_bytes(b"hi", b"hello")); // 比 haystack 长
        assert!(!has_bytes(b"ab", b"abc")); // 只差一个字节
        assert!(!has_bytes(b"abc", b"")); // 空串不算命中
        assert!(!has_bytes(b"", b"x"));
    }

    #[test]
    fn walk_repos_skips_heavy_dirs_and_finds_root() {
        let base = std::env::temp_dir().join(format!("nifecode-repos-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("sub/.git")).unwrap();
        std::fs::create_dir_all(base.join("node_modules/x/.git")).unwrap();
        let mut out = Vec::new();
        let mut budget = 300;
        walk_repos(&base, "", 0, 3, &mut budget, &mut out);
        assert_eq!(out, vec!["sub".to_string()]); // 根不是仓库，node_modules 不进去
        std::fs::create_dir_all(base.join(".git")).unwrap();
        let mut out2 = Vec::new();
        let mut budget2 = 300;
        walk_repos(&base, "", 0, 3, &mut budget2, &mut out2);
        assert_eq!(out2, vec![String::new(), "sub".to_string()]); // "" = 根目录排第一
        let _ = std::fs::remove_dir_all(&base);
    }
}
