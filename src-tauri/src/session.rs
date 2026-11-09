//! 常驻 ssh 执行通道
//!
//! 每打开一条 `ssh -T <host> bash`，之后的命令直接写进它的 stdin、从 stdout 读结果，
//! 省掉每次操作重新 TCP + 握手 + 认证（在 237ms RTT 的链路上就是 3 秒 vs 0.3 秒）。
//!
//! 协议：一行一条命令，输出用 base64 包起来，靠标记行分割：
//!   NIFEB <id>
//!   <base64>
//!   NIFER <id> <退出码>
//!   NIFEE <id>
//!
//! 用 bash 读 stdin 逐行执行，所以**命令必须是单行**。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout};
use std::sync::{Arc, Mutex, OnceLock};

pub struct Session {
    child: Child,
    stdin: ChildStdin,
    out: BufReader<ChildStdout>,
    seq: u64,
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(s: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .unwrap_or_default()
}

impl Session {
    fn open(target: &str, port: u16) -> Result<Self, String> {
        let mut cmd = crate::fsops::ssh_command(target, port);
        cmd.arg("-T")
            .arg(target)
            .arg("bash")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("起 ssh 失败：{e}"))?;
        let stdin = child.stdin.take().ok_or("拿不到 ssh stdin")?;
        let stdout = child.stdout.take().ok_or("拿不到 ssh stdout")?;

        // ssh 把"密码错了""主机不可达"都写在 stderr 上，不接着就只能回一句"通道断了"
        let errbuf = Arc::new(Mutex::new(String::new()));
        if let Some(e) = child.stderr.take() {
            let eb = errbuf.clone();
            std::thread::spawn(move || {
                use std::io::Read;
                let mut text = String::new();
                let mut r = std::io::BufReader::new(e);
                let _ = r.read_to_string(&mut text);
                if let Ok(mut g) = eb.lock() {
                    g.push_str(&text);
                }
            });
        }

        let mut s = Session { child, stdin, out: BufReader::new(stdout), seq: 0 };
        // 先打个标记把 banner / .bashrc 输出吃掉
        let r = s.exec_raw("echo ready");
        let ok = matches!(&r, Ok((0, out)) if String::from_utf8_lossy(out).contains("ready"));
        if ok {
            return Ok(s);
        }
        s.kill();
        std::thread::sleep(std::time::Duration::from_millis(80)); // 等 stderr 读完
        let detail = errbuf.lock().map(|g| g.trim().to_string()).unwrap_or_default();
        let base = match r {
            Ok((code, _)) => format!("远端 bash 没起来（退出码 {code}）"),
            Err(e) => e,
        };
        // stderr 里有 ssh 的真实原因（密码错 / 连不上），就用它当错误信息
        Err(if detail.is_empty() { base } else { detail })
    }

    fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    fn exec_raw(&mut self, command: &str) -> Result<(i32, Vec<u8>), String> {
        self.seq += 1;
        let id = self.seq;
        // 单行：标记 + 命令输出 base64 + 退出码 + 结束标记
        let line = format!(
            "printf 'NIFEB {id}\\n'; {{ {command} ; }} 2>&1 | base64 -w0; printf '\\nNIFER {id} %s\\nNIFEE {id}\\n' \"${{PIPESTATUS[0]}}\"\n"
        );
        self.stdin.write_all(line.as_bytes()).map_err(|e| format!("写 ssh 通道失败：{e}"))?;
        self.stdin.flush().map_err(|e| e.to_string())?;

        let begin = format!("NIFEB {id}");
        let ret_prefix = format!("NIFER {id} ");
        let end = format!("NIFEE {id}");

        let mut payload = String::new();
        let mut code = 0i32;
        let mut started = false;
        let mut buf = String::new();
        loop {
            buf.clear();
            let n = self.out.read_line(&mut buf).map_err(|e| format!("读 ssh 通道失败：{e}"))?;
            if n == 0 {
                return Err("ssh 通道断了".into());
            }
            let line = buf.trim_end();
            if !started {
                if line == begin {
                    started = true;
                }
                continue;
            }
            if line == end {
                return Ok((code, unb64(&payload)));
            }
            if let Some(rest) = line.strip_prefix(&ret_prefix) {
                code = rest.trim().parse().unwrap_or(0);
                continue;
            }
            payload.push_str(line);
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // 通道废弃时必须把 ssh 子进程收掉，否则每失败一次就漏一个 ssh
        self.kill();
    }
}

fn pool() -> &'static Mutex<HashMap<String, Arc<Mutex<Session>>>> {
    static POOL: OnceLock<Mutex<HashMap<String, Arc<Mutex<Session>>>>> = OnceLock::new();
    POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn key_of(target: &str, port: u16) -> String {
    format!("{target}:{port}")
}

/// 通过常驻通道执行；通道没建起来就返回 Err，让调用方回落到普通 ssh
///
/// 注意：`Session::open` 是慢操作（一次完整 ssh 握手，慢链路能到几秒），
/// 所以**绝对不能持有全局 pool 锁去开通道**，否则同一时刻所有远端操作都得排队。
pub fn exec(target: &str, port: u16, command: &str) -> Result<(i32, Vec<u8>), String> {
    // ssh 通道里跑的是 bash，命令里不能有换行
    let one_line = command.replace('\n', " ");
    let k = key_of(target, port);

    // 快路径：通道已经在
    let existing = lock_pool().get(&k).cloned();
    let sess = match existing {
        Some(a) => a,
        None => {
            let fresh = Arc::new(Mutex::new(Session::open(target, port)?));
            let mut g = lock_pool();
            match g.get(&k).cloned() {
                // 别人抢先建好了：用他那条，自己这条丢掉（Drop 会杀掉 ssh）
                Some(other) => {
                    drop(g);
                    drop(fresh);
                    other
                }
                None => {
                    g.insert(k.clone(), fresh.clone());
                    fresh
                }
            }
        }
    };

    let r = {
        let mut s = sess.lock().unwrap_or_else(|e| e.into_inner());
        s.exec_raw(&one_line)
    };
    if r.is_err() {
        // 通道坏了就丢掉，下次重开（Arc 落到底时 Drop 杀 ssh）
        lock_pool().remove(&k);
    }
    r
}

/// 断开连接时把通道里的 ssh 子进程杀掉
pub fn close_all() {
    let drained: Vec<Arc<Mutex<Session>>> = lock_pool().drain().map(|(_, v)| v).collect();
    drop(drained); // 最后一个 Arc 落地时 Session::drop 会 kill + wait
}

fn lock_pool() -> std::sync::MutexGuard<'static, HashMap<String, Arc<Mutex<Session>>>> {
    pool().lock().unwrap_or_else(|e| e.into_inner())
}

pub fn b64_encode(bytes: &[u8]) -> String {
    b64(bytes)
}

#[cfg(test)]
mod tests {
    #[test]
    fn roundtrip_markers() {
        // 只是确认我们的标记格式本身不歧义
        let cmd = "printf 'NIFEB 1\\n'; echo hi | base64 -w0; printf '\\nNIFER 1 %s\\nNIFEE 1\\n' 0";
        assert!(cmd.contains("NIFEB 1"));
        assert!(cmd.contains("NIFEE 1"));
    }
}
