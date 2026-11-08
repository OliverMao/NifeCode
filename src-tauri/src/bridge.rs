use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

pub const PORT: u16 = 7317;

#[derive(Default)]
pub struct BridgeState(pub Mutex<serde_json::Value>);

#[tauri::command]
pub fn bridge_set_state(st: State<BridgeState>, state: serde_json::Value) {
    *st.0.lock().unwrap() = state;
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let listener = match TcpListener::bind(("127.0.0.1", PORT)) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[bridge] 端口 {PORT} 绑定失败：{e}");
                return;
            }
        };
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || {
                let _ = handle(stream, app);
            });
        }
    });
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// 返回 (body 起始位置, body 长度)；请求头不完整时返回 None
fn parse_head(buf: &[u8]) -> Option<(usize, usize)> {
    let pos = find(buf, b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&buf[..pos]).to_ascii_lowercase();
    let cl = head
        .lines()
        .find_map(|l| {
            l.strip_prefix("content-length:")
                .and_then(|v| v.trim().parse::<usize>().ok())
        })
        .unwrap_or(0);
    if buf.len() < pos + 4 + cl {
        return None;
    }
    Some((pos + 4, cl))
}

fn handle(mut stream: TcpStream, app: AppHandle) -> std::io::Result<()> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];

    let (start, content_len) = loop {
        if let Some(v) = parse_head(&buf) {
            break v;
        }
        match stream.read(&mut tmp) {
            Ok(0) => break (0, 0),
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
            Err(_) => return Ok(()),
        }
    };

    if start == 0 {
        return respond(&mut stream, 400, "bad request");
    }

    let head = String::from_utf8_lossy(&buf[..start]).to_string();
    let end = (start + content_len).min(buf.len());
    let body = &buf[start..end];
    let json: serde_json::Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => {
            eprintln!(
                "[bridge] JSON 解析失败: {e} (cl={content_len} buflen={} start={start})",
                buf.len()
            );
            serde_json::Value::Null
        }
    };

    let mut req = head.lines().next().unwrap_or("").split_whitespace();
    let method = req.next().unwrap_or("");
    let path = req.next().unwrap_or("/");
    eprintln!("[bridge] {method} {path}");

    match (method, path) {
        ("GET", "/state") => {
            let st = app.state::<BridgeState>();
            let v = st.0.lock().unwrap().clone();
            return respond_json(&mut stream, 200, &v);
        }
        ("POST", "/open") => {
            if let Err(e) = app.emit("bridge:open", json.clone()) {
                eprintln!("[bridge] emit open 失败: {e}");
            }
        }
        ("POST", "/diff") => {
            if let Err(e) = app.emit("bridge:diff", json.clone()) {
                eprintln!("[bridge] emit diff 失败: {e}");
            }
        }
        ("POST", "/save") => {
            let _ = app.emit("bridge:save", json);
        }
        ("POST", "/workspace") => {
            if let Err(e) = app.emit("bridge:workspace", json.clone()) {
                eprintln!("[bridge] emit workspace 失败: {e}");
            }
        }
        _ => return respond(&mut stream, 404, "not found"),
    }
    respond_json(&mut stream, 200, &serde_json::json!({ "ok": true }))
}

fn respond(stream: &mut TcpStream, code: u16, msg: &str) -> std::io::Result<()> {
    let body = format!("{{\"ok\":false,\"error\":\"{msg}\"}}");
    let resp = format!(
        "HTTP/1.1 {code} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(resp.as_bytes())
}

fn respond_json(stream: &mut TcpStream, code: u16, v: &serde_json::Value) -> std::io::Result<()> {
    let body = v.to_string();
    let resp = format!(
        "HTTP/1.1 {code} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(resp.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_request() {
        let req = b"POST /open HTTP/1.1\r\nContent-Length: 5\r\n\r\nhello";
        let (start, len) = parse_head(req).expect("应能解析");
        assert_eq!(len, 5);
        assert_eq!(&req[start..start + len], b"hello");
    }

    #[test]
    fn incomplete_head_returns_none() {
        assert!(parse_head(b"POST /open HTTP/1.1\r\n").is_none());
    }

    #[test]
    fn partial_body_returns_none() {
        let req = b"POST /open HTTP/1.1\r\nContent-Length: 50\r\n\r\nhi";
        assert!(parse_head(req).is_none());
    }

    #[test]
    fn get_without_body() {
        let req = b"GET /state HTTP/1.1\r\nHost: x\r\n\r\n";
        let (start, len) = parse_head(req).unwrap();
        assert_eq!(len, 0);
        assert_eq!(start, req.len());
    }
}
