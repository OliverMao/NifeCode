// WebView2 缓存清理：只删可重建的缓存目录，绝不碰 Local Storage / 登录态 / 配置
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// 相对 EBWebView 的、纯缓存（删了会自动重建）的目录白名单
const CACHE_DIRS: [&str; 13] = [
    "Default/Code Cache",
    "Default/Cache",
    "Default/GPUCache",
    "Default/DawnCache",
    "Default/DawnGraphiteCache",
    "Default/DawnWebGPUCache",
    "Default/GrShaderCache",
    "Default/ShaderCache",
    "GPUCache",
    "GrShaderCache",
    "ShaderCache",
    "component_crx_cache",
    "Subresource Filter",
];

/// 这两个占地方大但不是缓存（DRM 组件、崩溃记录），单独点名删
const EXTRA_DIRS: [&str; 2] = ["WidevineCdm", "Crashpad"];

#[derive(Serialize)]
pub struct CacheInfo {
    pub bytes: u64,
    pub dir: String,
}

fn webview_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // 默认就是 %LOCALAPPDATA%\{identifier}\EBWebView
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("拿不到应用数据目录：{e}"))?;
    Ok(base.join("EBWebView"))
}

fn dir_size(p: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(p) else { return 0 };
    let mut n = 0;
    for e in rd.flatten() {
        let path = e.path();
        match e.file_type() {
            Ok(t) if t.is_dir() => n += dir_size(&path),
            Ok(t) if t.is_file() => n += e.metadata().map(|m| m.len()).unwrap_or(0),
            _ => {}
        }
    }
    n
}

fn remove_dir(p: &Path) -> u64 {
    // 删之前先算大小；删的过程中被占用的文件跳过（运行中的 WebView 会锁少量文件）
    let freed = dir_size(p);
    if std::fs::remove_dir_all(p).is_ok() {
        return freed;
    }
    // 删不掉整个目录就逐个文件删，能删多少算多少
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            let path = e.path();
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(&path);
            } else {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    freed.saturating_sub(dir_size(p))
}

fn targets(root: &Path) -> Vec<PathBuf> {
    CACHE_DIRS
        .iter()
        .chain(EXTRA_DIRS.iter())
        .map(|d| root.join(d))
        .filter(|p| p.exists())
        .collect()
}

#[tauri::command]
pub async fn app_cache_size(app: tauri::AppHandle) -> Result<CacheInfo, String> {
    let root = webview_dir(&app)?;
    let bytes = targets(&root).iter().map(|p| dir_size(p)).sum();
    Ok(CacheInfo { bytes, dir: root.to_string_lossy().to_string() })
}

#[tauri::command]
pub async fn app_cache_clear(app: tauri::AppHandle) -> Result<u64, String> {
    let root = webview_dir(&app)?;
    let mut freed = 0;
    for p in targets(&root) {
        freed += remove_dir(&p);
    }
    Ok(freed)
}
