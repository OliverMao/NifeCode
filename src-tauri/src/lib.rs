mod bridge;
mod fsops;
mod proc;
mod session;
mod fwd;
mod git;
mod pty;

pub fn run() {
    tauri::Builder::default()
        .manage(pty::PtyState::default())
        .manage(bridge::BridgeState::default())
        .manage(fwd::FwdState::default())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            bridge::spawn(app.handle().clone());
            // 预热：本会话第一次跑外部命令会被系统扫描，垫一次省得用户等
            std::thread::spawn(|| {
                let mut c = std::process::Command::new("git");
                crate::proc::hide_console(&mut c);
                let _ = c.arg("--version").output();
            });
            Ok(())
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
            fsops::pick_folder,
            fsops::ssh_home,
            fsops::ssh_set_identity,
            fsops::ssh_close,
            fsops::fs_new,
            fsops::fs_rename,
            fsops::fs_delete,
            fsops::fs_copy,
            fsops::fs_reveal,
            fsops::list_files,
            fsops::ssh_save_password,
            fsops::ssh_forget_password,
            fsops::ssh_has_password,
            pty::pty_open,
            pty::shells,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            bridge::bridge_set_state,
            git::git_info,
            git::git_head_file,
            git::git_commit,
        ])
        .run(tauri::generate_context!())
        .expect("NifeCode 启动失败");
}

