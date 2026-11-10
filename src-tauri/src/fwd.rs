// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 OliverMao — NifeCode, 见仓库根目录 LICENSE
use serde::Serialize;
use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::State;

#[derive(Serialize, Clone)]
pub struct Forward {
    pub id: u32,
    pub local: u16,
    pub remote: String,
    pub target: String,
}

#[derive(Default)]
pub struct FwdState(pub Mutex<HashMap<u32, (Forward, Child)>>, pub std::sync::atomic::AtomicU32);

/// ssh -N -L：本地端口 → 远端服务的隧道（Jupyter / TensorBoard / 数据库）
#[tauri::command]
pub async fn fwd_start(
    st: State<'_, FwdState>,
    target: String,
    port: u16,
    local: u16,
    rhost: String,
    rport: u16,
) -> Result<Forward, String> {
    let rhost = if rhost.trim().is_empty() { "127.0.0.1".to_string() } else { rhost.trim().to_string() };
    let spec = format!("127.0.0.1:{local}:{rhost}:{rport}");
    let mut args: Vec<String> = vec![
        "-N".into(),
        "-o".into(), "BatchMode=yes".into(),
        "-o".into(), "ExitOnForwardFailure=yes".into(),
        "-o".into(), "ServerAliveInterval=30".into(),
    ];
    if let Some(key) = crate::fsops::current_identity(&target, port) {
        args.push("-i".into());
        args.push(key);
    }
    args.push("-p".into());
    args.push(port.to_string());
    args.push("-L".into());
    args.push(spec);
    args.push(target.clone());
    let mut cmd = Command::new("ssh");
    crate::proc::hide_console(&mut cmd);
    cmd.args(&args);
    for (k, v) in crate::fsops::secret_env(&target, port) {
        cmd.env(k, v);
    }
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动 ssh 失败：{e}"))?;

    // 等到本地端口真的能连上（或 ssh 退出）再返回，否则用户会看到一个假成功的转发
    let mut ok = false;
    for _ in 0..40 {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "端口转发没起来（ssh 退出码 {}）。检查：密钥能不能免密登录、本地 {local} 是否被占用",
                status.code().unwrap_or(-1)
            ));
        }
        if std::net::TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], local)),
            std::time::Duration::from_millis(120),
        )
        .is_ok()
        {
            ok = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(130));
    }
    if !ok {
        let _ = child.kill();
        return Err(format!("等了 5 秒本地 {local} 还没起来，转发失败"));
    }

    let id = st.1.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let fwd = Forward {
        id,
        local,
        remote: format!("{rhost}:{rport}"),
        target: target.clone(),
    };
    st.0.lock().unwrap().insert(id, (fwd.clone(), child));
    Ok(fwd)
}

#[tauri::command]
pub fn fwd_list(st: State<'_, FwdState>) -> Vec<Forward> {
    st.0.lock().unwrap().values().map(|(f, _)| f.clone()).collect()
}

#[tauri::command]
pub fn fwd_stop(st: State<'_, FwdState>, id: u32) {
    if let Some((_, mut child)) = st.0.lock().unwrap().remove(&id) {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[tauri::command]
pub fn fwd_stop_all(st: State<'_, FwdState>) {
    let mut guard = st.0.lock().unwrap();
    for (_, (_, mut child)) in guard.drain() {
        let _ = child.kill();
        let _ = child.wait();
    }
}
