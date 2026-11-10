// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 OliverMao — NifeCode, 见仓库根目录 LICENSE
// 把项目标签"拖出去"：在同一个进程里再开一个窗口，各有各的 JS 状态（标签页、终端、面板宽度）
use std::collections::HashMap;
use std::sync::LazyLock;
use std::sync::Mutex;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// 新窗口启动后自己来取一次：窗口 label → 要打开的东西
static PENDING: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
/// 每个窗口当前开着哪个项目（host + 路径），同一个项目只让一个窗口占
static ROOTS: LazyLock<Mutex<HashMap<String, (Option<String>, String)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// 路径统一成小写 + 正斜杠，免得反斜杠写法被当成另一个项目
fn norm(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// 开一个新窗口；root 用 JSON 字符串传（本机是路径，远端是"ssh|host|port|path"）
#[tauri::command]
pub async fn open_window(app: tauri::AppHandle, id: String, title: String, payload: String) -> Result<(), String> {
    PENDING.lock().unwrap().insert(id.clone(), payload);
    let url = WebviewUrl::App(format!("index.html?w={id}").into());
    let w = WebviewWindowBuilder::new(&app, &id, url)
        .title(&title)
        .inner_size(1280.0, 820.0)
        .min_inner_size(700.0, 480.0)
        .decorations(false)
        .build()
        .map_err(|e| format!("开新窗口失败：{e}"))?;
    let _ = w.set_focus();
    Ok(())
}

/// 新窗口启动时问一次："我该打开什么"
#[tauri::command]
pub fn window_payload(id: String) -> Option<String> {
    PENDING.lock().unwrap().remove(&id)
}

/// 登记"这个窗口当前开的是哪个项目"；check=true 时如果别的窗口已经开着同一个项目，
/// 就把那个窗口顶到前面并返回它的 label（调用方应该把自己关掉）
#[tauri::command]
pub async fn window_claim_root(
    app: tauri::AppHandle,
    id: String,
    host: Option<String>,
    root: String,
    check: bool,
) -> Option<String> {
    if root.is_empty() {
        ROOTS.lock().unwrap().remove(&id);
        return None;
    }
    let key = (host.map(|h| h.to_lowercase()), norm(&root));
    let other: Option<String> = {
        let m = ROOTS.lock().unwrap();
        m.iter().find(|(l, v)| **l != id && **v == key).map(|(l, _)| l.clone())
    };
    if check {
        if let Some(other) = other {
            if let Some(w) = app.get_webview_window(&other) {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            return Some(other);
        }
    }
    ROOTS.lock().unwrap().insert(id, key);
    None
}

/// 窗口关掉了：把它的登记去掉，别让后面的窗口以为项目还占着
pub fn forget(id: &str) {
    ROOTS.lock().unwrap().remove(id);
}
