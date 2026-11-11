// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 OliverMao — NifeCode, 见仓库根目录 LICENSE
//! 资源管理器右键菜单「用 NifeCode 打开」
//!
//! 只写 `HKCU\Software\Classes`（不需要管理员权限，卸载/取消就是删掉这几个键）。
//! Win11 的新版右键菜单只认打包（MSIX）应用，这个条目落在「显示更多选项」里。
use std::io::{Read, Write};
use std::process::Command;

const TITLE: &str = "用 NifeCode 打开";

/// 三处：任意文件、文件夹本身、文件夹空白处（+`%V`）
fn keys() -> [(&'static str, &'static str); 3] {
    [
        (r"HKCU\Software\Classes\*\shell\NifeCode", "%1"),
        (r"HKCU\Software\Classes\Directory\shell\NifeCode", "%1"),
        (r"HKCU\Software\Classes\Directory\Background\shell\NifeCode", "%V"),
    ]
}

fn reg(args: &[&str]) -> Result<(), String> {
    let mut c = Command::new("reg");
    crate::proc::hide_console(&mut c);
    let out = c.args(args).output().map_err(|e| format!("调不到 reg.exe：{e}"))?;
    if out.status.success() {
        return Ok(());
    }
    // reg.exe 把错误信息写在 stdout 上
    let msg = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Err(if msg.is_empty() { format!("reg 失败（{}）", out.status) } else { msg })
}

/// 加/删右键菜单。开着就把命令写成 `"<exe>" "%1"`，关了就把那几个键删掉
#[tauri::command]
pub fn shell_menu_set(on: bool) -> Result<(), String> {
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("拿不到程序路径：{e}"))?;
    for (key, arg) in keys() {
        if !on {
            let _ = reg(&["delete", key, "/f"]); // 不存在就当已经删了
            continue;
        }
        reg(&["add", key, "/ve", "/d", TITLE, "/f"])?;
        reg(&["add", key, "/v", "Icon", "/d", &format!("{exe},0"), "/f"])?;
        // 多选时不要在资源管理器里一口气开一堆实例
        reg(&["add", key, "/v", "MultiSelectModel", "/d", "Single", "/f"])?;
        let command = format!("{key}\\command");
        let value = format!("\"{exe}\" \"{arg}\"");
        reg(&["add", &command, "/ve", "/d", &value, "/f"])?;
    }
    Ok(())
}

/// 注册表里现在有没有（设置面板显示用；用户手动删了也能显示成"关"）
#[tauri::command]
pub fn shell_menu_state() -> bool {
    keys().iter().all(|(key, _)| {
        let mut c = Command::new("reg");
        crate::proc::hide_console(&mut c);
        c.arg("query").arg(key).output().map(|o| o.status.success()).unwrap_or(false)
    })
}

/// 命令行里带进来的路径（右键菜单给的就是绝对路径）
pub(crate) fn arg_path() -> Option<String> {
    // 跳过 `--flag`（Tauri/WebView 偶尔会塞自己的参数）
    std::env::args().skip(1).find(|a| !a.starts_with('-')).map(|a| a.trim_matches('"').to_string())
}

/// 启动时要打开的路径，以及它是文件夹还是文件
#[tauri::command]
pub fn startup_target() -> Option<serde_json::Value> {
    let path = arg_path()?;
    let is_dir = std::fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false);
    Some(serde_json::json!({ "path": path.replace('\\', "/"), "is_dir": is_dir }))
}

/// 已经有实例在跑（7317 被占）时把路径转给它，自己就别再开窗口了：
/// 同一个 WebView2 数据目录塞两个进程不靠谱
pub fn forward_to_running(path: &str) -> bool {
    if std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], crate::bridge::PORT)),
        std::time::Duration::from_millis(300),
    )
    .is_err()
    {
        return false;
    }
    // 文件夹当工作区、文件直接打开，正好对上 bridge 已有的两个接口
    let is_dir = std::fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false);
    let route = if is_dir { "/workspace" } else { "/open" };
    let body = serde_json::json!({ "path": path }).to_string();
    let req = format!(
        "POST {route} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let Ok(mut s) = std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], crate::bridge::PORT)),
        std::time::Duration::from_millis(500),
    ) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(8)));
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    match s.read(&mut buf) {
        Ok(n) => String::from_utf8_lossy(&buf[..n]).contains(" 200"),
        Err(_) => false,
    }
}
