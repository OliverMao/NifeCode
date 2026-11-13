// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 OliverMao — NifeCode, 见仓库根目录 LICENSE
mod bridge;
mod cache;
mod fsops;
mod proc;
mod session;
mod shell;
mod fwd;
mod git;
mod pty;
mod update;
mod win;

pub fn run() {
    // 右键菜单「用 NifeCode 打开」起的新实例：已经有窗口在跑就把路径转给它，本进程直接退出
    if let Some(p) = shell::arg_path() {
        if shell::forward_to_running(&p) {
            return;
        }
    }
    tauri::Builder::default()
        .manage(pty::PtyState::default())
        .manage(bridge::BridgeState::default())
        .manage(fwd::FwdState::default())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            bridge::spawn(app.handle().clone());
            update::cleanup_old();
            // 预热：本会话第一次跑外部命令会被系统扫描，垫一次省得用户等
            std::thread::spawn(|| {
                let mut c = std::process::Command::new("git");
                crate::proc::hide_console(&mut c);
                let _ = c.arg("--version").output();
            });
            Ok(())
        })
        .on_window_event(|w, ev| {
            if let tauri::WindowEvent::Destroyed = ev {
                win::forget(w.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            fsops::read_file,
            fsops::write_file,
            fsops::read_dir,
            fsops::stat_file,
            fsops::stat_files,
            fsops::search,
            fwd::fwd_start,
            fwd::fwd_list,
            fwd::fwd_stop,
            fwd::fwd_stop_all,
            fsops::home_dir,
            fsops::ssh_home,
            fsops::ssh_set_identity,
            fsops::ssh_close,
            fsops::fs_new,
            fsops::fs_rename,
            fsops::fs_delete,
            fsops::fs_copy,
            fsops::fs_reveal,
            fsops::list_files,
            fsops::find_repos,
            fsops::replace_all,
            fsops::read_binary,
            fsops::fs_open,
            fsops::ssh_forget_host,
            shell::shell_menu_set,
            shell::shell_menu_state,
            shell::is_installed,
            shell::startup_target,
            cache::app_cache_size,
            cache::app_cache_clear,
            fsops::ssh_save_password,
            fsops::ssh_forget_password,
            fsops::ssh_has_password,
            pty::pty_open,
            pty::shells,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            bridge::bridge_set_state,
            bridge::bridge_save_result,
            proc::open_url,
            git::git_info,
            git::git_head_file,
            git::git_commit,
            update::update_check,
            update::update_install,
            win::open_window,
            win::window_payload,
            win::window_claim_root,
        ])
        .run(tauri::generate_context!())
        .expect("NifeCode 启动失败");
}

