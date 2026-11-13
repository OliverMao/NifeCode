// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 OliverMao — NifeCode, 见仓库根目录 LICENSE
// AI 行内补全的出口：key 存 Windows 凭据管理器，请求用 curl 发。
// 不走前端 fetch 是因为网关大多不给 CORS（预检直接 401），WebView2 里跨域会被拦下。
use std::io::Write;
use std::process::{Command, Stdio};

const AI_KEY: &str = "ai-key";

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(crate::fsops::KEYRING_SERVICE, AI_KEY)
        .map_err(|e| format!("打开凭据存储失败：{e}"))
}

#[tauri::command]
pub async fn ai_key_saved() -> bool {
    entry().ok().and_then(|e| e.get_password().ok()).is_some()
}

#[tauri::command]
pub async fn ai_key_set(key: String) -> Result<(), String> {
    let e = entry()?;
    if key.is_empty() {
        let _ = e.delete_credential();
        return Ok(());
    }
    e.set_password(&key)
        .map_err(|err| format!("保存到 Windows 凭据管理器失败：{err}"))
}

/// 代发一次请求：url 已是完整的 .../chat/completions，body 是前端拼好的 JSON（原样透传）。
/// 只在这里补 Authorization，所以 key 不会进前端存储。
#[tauri::command]
pub async fn ai_post(url: String, body: String) -> Result<String, String> {
    let key = entry()?
        .get_password()
        .map_err(|_| "设置里还没填 API Key".to_string())?;
    tauri::async_runtime::spawn_blocking(move || post(&url, &key, &body))
        .await
        .map_err(|e| e.to_string())?
}

fn post(url: &str, key: &str, body: &str) -> Result<String, String> {
    let mut cmd = Command::new("curl");
    cmd.args([
        "-sS",
        "--max-time",
        "25",
        "-X",
        "POST",
        url,
        "-H",
        "Content-Type: application/json",
        "-H",
        &format!("Authorization: Bearer {key}"),
        // 提示词里全是引号换行，走命令行会被转义搞死，直接吃 stdin
        "--data-binary",
        "@-",
        // 响应体后面接状态码：网关出错时回的是 HTML，光靠 curl 的退出码分不清"限流"和"配错了"
        "-w",
        "\n__HTTP__%{http_code}",
    ])
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    let mut child = crate::proc::hide_console(&mut cmd)
        .spawn()
        .map_err(|e| format!("curl 启动失败: {e}"))?;
    child
        .stdin
        .as_mut()
        .ok_or("curl stdin 不可用")?
        .write_all(body.as_bytes())
        .map_err(|e| format!("写入请求失败: {e}"))?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let (payload, status) = text.rsplit_once("\n__HTTP__").unwrap_or((text.as_str(), "0"));
    let code: u16 = status.trim().parse().unwrap_or(0);
    if !out.status.success() && payload.trim().is_empty() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("请求失败（HTTP {code}）")
        } else {
            format!("请求失败：{err}")
        });
    }
    if code != 200 {
        let brief: String = payload.trim().chars().take(200).collect();
        return Err(format!("HTTP {code}：{brief}"));
    }
    Ok(payload.to_string())
}
