// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 OliverMao — NifeCode, 见仓库根目录 LICENSE
// 自动更新：查 GitHub Release → 下载便携版 exe → 换掉自己 → 重启
// 不依赖 tauri-plugin-updater：那套只认 NSIS/MSI 安装包，还要维护签名私钥；
// 便携版这里用 Windows「运行中的 exe 可以改名」的特性原地换掉，不需要管理员权限。
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

/// 更新源。仓库转成公开后直接可用；要换成别的中转地址就设这个环境变量
const DEFAULT_API: &str = "https://api.github.com/repos/OliverMao/NifeCode/releases/latest";

#[derive(Serialize)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub size: u64,
    pub url: String,
    pub notes: String,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    size: u64,
    browser_download_url: String,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    assets: Vec<Asset>,
}

fn api_url() -> String {
    std::env::var("NIFECODE_UPDATE_URL").unwrap_or_else(|_| DEFAULT_API.to_string())
}

fn curl(url: &str, out: Option<&PathBuf>) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new("curl");
    cmd.args(["-sSL", "--max-time", "60", "-H", "User-Agent: NifeCode"]);
    if let Some(p) = out {
        cmd.arg("-o").arg(p);
    }
    cmd.arg(url);
    let o = crate::proc::hide_console(&mut cmd)
        .output()
        .map_err(|e| format!("curl 启动失败: {e}"))?;
    if !o.status.success() {
        let msg = String::from_utf8_lossy(&o.stderr).trim().to_string();
        return Err(if msg.is_empty() {
            format!("请求失败 (HTTP {}", o.status.code().unwrap_or(-1))
        } else {
            msg
        });
    }
    Ok(o.stdout)
}

/// "v0.1.10" vs "0.1.9" → 逐段按数字比
fn newer(latest: &str, current: &str) -> bool {
    let p = |s: &str| -> Vec<u64> {
        s.trim_start_matches('v')
            .split(['.', '-', '+'])
            .map(|x| x.parse().unwrap_or(0))
            .collect()
    };
    let (a, b) = (p(latest), p(current));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let current = app.package_info().version.to_string();
    let raw = tauri::async_runtime::spawn_blocking(move || curl(&api_url(), None))
        .await
        .map_err(|e| e.to_string())??;
    let rel: Release =
        serde_json::from_slice(&raw).map_err(|_| "更新源返回的不是 Release JSON（私有仓库会 404）".to_string())?;
    if !newer(&rel.tag_name, &current) {
        return Ok(None);
    }
    // 优先便携版 exe；只有安装包时也能用（那种情况会失败并给出提示）
    let pick = rel
        .assets
        .iter()
        .find(|a| a.name.contains("portable") && a.name.ends_with(".exe"))
        .or_else(|| rel.assets.iter().find(|a| a.name.ends_with(".exe")));
    let Some(a) = pick else {
        return Err("这个 Release 里没有 .exe 资产".into());
    };
    Ok(Some(UpdateInfo {
        current,
        latest: rel.tag_name.trim_start_matches('v').to_string(),
        size: a.size,
        url: a.browser_download_url.clone(),
        notes: rel.body,
    }))
}

#[tauri::command]
pub async fn update_install(app: tauri::AppHandle, url: String, size: u64) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("拿不到自己的路径: {e}"))?;
    let dir = exe.parent().ok_or("拿不到程序目录")?.to_path_buf();
    let tmp = dir.join("NifeCode.update.exe");
    let old = dir.join("NifeCode.old.exe");
    let _ = std::fs::remove_file(&tmp);

    let dl = tmp.clone();
    tauri::async_runtime::spawn_blocking(move || curl(&url, Some(&dl)))
        .await
        .map_err(|e| e.to_string())??;

    let got = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
    if got == 0 || (size > 0 && got != size) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("下载不完整（{got} / {size} 字节）"));
    }

    // 运行中的 exe 不能覆盖，但可以先改名
    let _ = std::fs::remove_file(&old);
    std::fs::rename(&exe, &old).map_err(|e| format!("程序目录不可写，请手动下载安装包: {e}"))?;
    if let Err(e) = std::fs::rename(&tmp, &exe) {
        let _ = std::fs::rename(&old, &exe); // 换不上去就先恢复原样
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("替换失败: {e}"));
    }
    Command::new(&exe)
        .spawn()
        .map_err(|e| format!("启动新版本失败: {e}"))?;
    std::thread::sleep(std::time::Duration::from_millis(200));
    app.exit(0);
    Ok(())
}

/// 上次更新留下的旧 exe，启动时顺手删掉
pub fn cleanup_old() {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let _ = std::fs::remove_file(dir.join("NifeCode.old.exe"));
        }
    }
}
