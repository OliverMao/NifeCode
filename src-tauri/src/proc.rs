// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 OliverMao — NifeCode, 见仓库根目录 LICENSE
use std::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 从 GUI 进程 spawn 控制台程序（ssh/git）时，不加这个标志会弹出一个黑色控制台窗口
pub fn hide_console(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// 用系统默认程序打开 http/https 链接。
/// rundll32 只吃一个参数（不走 cmd），URL 里有 `&` `|` 也不会被当命令解释
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("只支持 http/https 链接".into());
    }
    let mut c = Command::new("rundll32.exe");
    c.arg("url.dll,FileProtocolHandler").arg(&url);
    hide_console(&mut c);
    c.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::open_url;

    #[test]
    fn rejects_non_http() {
        assert!(open_url("file:///C:/Windows".into()).is_err());
        assert!(open_url("calc.exe".into()).is_err());
    }
}
