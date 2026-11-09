#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 OliverMao — NifeCode, 见仓库根目录 LICENSE

fn main() {
    // ssh 需要密码时会把本程序当 SSH_ASKPASS 助手调起来，直接吐密码然后退出。
    //
    // 注意：Windows 上的 ssh 调 askpass 时**只把提示语当参数传进来**，不带 `--askpass`
    // （前一个版本就靠这个参数判断，结果每次都把整个 GUI 又启了一遍，ssh 拿不到密码就一直卡着）。
    // 所以改成"带 --askpass 参数"或者"环境里有 NIFECODE_ASKPASS"都算 askpass 模式。
    let askpass_env = std::env::var_os("NIFECODE_ASKPASS").is_some();
    if askpass_env || std::env::args().any(|a| a == "--askpass") {
        use std::io::Write;
        let pw = std::env::var("NIFECODE_ASKPASS").unwrap_or_default();
        let mut out = std::io::stdout();
        let _ = out.write_all(pw.as_bytes());
        let _ = out.flush();
        return;
    }
    nifecode_lib::run()
}
