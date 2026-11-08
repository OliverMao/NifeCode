#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // ssh 需要密码时会把本程序当 SSH_ASKPASS 助手调起来，直接吐密码然后退出
    if std::env::args().any(|a| a == "--askpass") {
        use std::io::Write;
        let pw = std::env::var("NIFECODE_ASKPASS").unwrap_or_default();
        let mut out = std::io::stdout();
        let _ = out.write_all(pw.as_bytes());
        let _ = out.flush();
        return;
    }
    nifecode_lib::run()
}
