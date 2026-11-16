// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 OliverMao — NifeCode, 见仓库根目录 LICENSE
//! 系统剪贴板里的「文件」（Windows 资源管理器里 Ctrl+C 的那几个）。
//! Tauri 的剪贴板插件只给文本和图片，文件列表是 CF_HDROP，得自己问系统。

/// 剪贴板里的文件绝对路径（正斜杠）；非 Windows、或剪贴板里不是文件时返回空
#[tauri::command]
pub fn clip_files() -> Vec<String> {
    #[cfg(windows)]
    {
        win::hdrops()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// 把文件放进系统剪贴板：Windows 资源管理器里 Ctrl+V 就是真复制这几个文件。
/// 同时塞一份纯文本路径，粘到终端里也能用。只能放本机路径
#[tauri::command]
pub fn clip_set_files(paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("没有文件可放".into());
    }
    #[cfg(windows)]
    {
        win::set_hdrops(&paths)
    }
    #[cfg(not(windows))]
    {
        Err("这个平台还不支持把文件放进剪贴板".into())
    }
}

#[cfg(windows)]
mod win {
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
        SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
    };

    /// 剪贴板的两个格式号，Windows 几十年没改过这两个值
    const CF_HDROP: u32 = 15;
    const CF_UNICODETEXT: u32 = 13;

    pub fn hdrops() -> Vec<String> {
        let Some(open) = open() else { return Vec::new() };
        let out = unsafe { collect() };
        drop(open);
        out
    }

    pub fn set_hdrops(paths: &[String]) -> Result<(), String> {
        let Some(open) = open() else {
            return Err("剪贴板被别的程序占着，过一下再试".into());
        };
        let r = unsafe { write(paths) };
        drop(open);
        r
    }

    /// 开剪贴板，被占着就隔一会儿重试几次（复制大文件时很常见）
    fn open() -> Option<OpenGuard> {
        for _ in 0..5 {
            if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
                return Some(OpenGuard);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        None
    }

    /// 出了作用域就关掉，不用在每个返回点手写 CloseClipboard
    struct OpenGuard;
    impl Drop for OpenGuard {
        fn drop(&mut self) {
            unsafe { CloseClipboard() };
        }
    }

    /// 把字节拷进一块可移动的全局内存交给系统；SetClipboardData 成功后这块内存归系统，不能自己 free
    unsafe fn hand_over(format: u32, bytes: &[u8]) -> Result<(), String> {
        let h: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
        if h.is_null() {
            return Err("分配剪贴板内存失败".into());
        }
        let p = GlobalLock(h) as *mut u8;
        if p.is_null() {
            GlobalFree(h);
            return Err("锁不住剪贴板内存".into());
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
        GlobalUnlock(h);
        if SetClipboardData(format, h).is_null() {
            GlobalFree(h);
            return Err("往剪贴板写数据失败".into());
        }
        Ok(())
    }

    unsafe fn write(paths: &[String]) -> Result<(), String> {
        if EmptyClipboard() == 0 {
            return Err("清空剪贴板失败".into());
        }
        // DROPFILES 头 20 字节（pFiles=20、pt 全 0、fNC=0、fWide=1），后面跟 UTF-16 路径列表：
        // 每条以 \0 结尾，整个列表再补一个 \0
        let mut list: Vec<u16> = Vec::new();
        for p in paths {
            // 资源管理器只认反斜杠，正斜杠路径粘过去会变成空文件夹
            list.extend(p.replace('/', "\\").encode_utf16());
            list.push(0);
        }
        list.push(0);
        let mut buf = vec![0u8; 20];
        buf[0..4].copy_from_slice(&20u32.to_le_bytes());
        buf[16] = 1; // fWide
        let mut bytes = buf;
        bytes.extend(list.iter().flat_map(|u| u.to_le_bytes()));
        hand_over(CF_HDROP, &bytes)?;
        // 再放一份文本：终端 / 输入框里粘贴就是路径清单
        let text: Vec<u16> = paths.join("\r\n").encode_utf16().chain(std::iter::once(0)).collect();
        hand_over(CF_UNICODETEXT, &text.iter().flat_map(|u| u.to_le_bytes()).collect::<Vec<u8>>())
    }

    unsafe fn collect() -> Vec<String> {
        if IsClipboardFormatAvailable(CF_HDROP) == 0 {
            return Vec::new();
        }
        let h: HANDLE = GetClipboardData(CF_HDROP);
        if h.is_null() {
            return Vec::new();
        }
        let base = GlobalLock(h) as *const u8;
        if base.is_null() {
            return Vec::new();
        }
        let size = GlobalSize(h);
        let mut out = Vec::new();
        // DROPFILES 头 20 字节：pFiles（文件列表相对本块的偏移）在 0，fWide 在 16
        if size > 20 {
            let p_files = u32::from_le_bytes([*base, *base.add(1), *base.add(2), *base.add(3)]) as usize;
            let wide = *base.add(16) != 0;
            if p_files < size {
                let body = std::slice::from_raw_parts(base.add(p_files), size - p_files);
                if wide {
                    let units: Vec<u16> = body
                        .chunks_exact(2)
                        .map(|c| u16::from_le_bytes([c[0], c[1]]))
                        .collect();
                    // 每个路径以 \0 结尾，整个列表以空字符串（连着的第二个 \0）收尾
                    for seg in units.split(|u| *u == 0) {
                        if seg.is_empty() {
                            break;
                        }
                        out.push(String::from_utf16_lossy(seg));
                    }
                } else {
                    // 老程序可能塞 ANSI 路径，按 UTF-8 尽量解，解不出来的字符替换掉
                    for seg in body.split(|b| *b == 0) {
                        if seg.is_empty() {
                            break;
                        }
                        out.push(String::from_utf8_lossy(seg).to_string());
                    }
                }
            }
        }
        GlobalUnlock(h);
        out.into_iter()
            .filter(|p| !p.is_empty())
            .map(|p| p.replace('\\', "/")) // 前端一律用正斜杠
            .collect()
    }
}
