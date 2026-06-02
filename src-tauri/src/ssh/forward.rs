// SSH port forwarding over an existing session.
//
// - local (-L):   bind 127.0.0.1:<local_port>; each connection opens a
//   direct-tcpip channel to <remote_host>:<remote_port> and pipes both ways.
// - dynamic (-D): a SOCKS5 proxy on 127.0.0.1:<local_port>; each CONNECT opens
//   a direct-tcpip channel to the requested host.
//
// (Remote -R forwarding needs server-initiated channels in the handler and is
// not implemented yet.)

use crate::error::AppError;
use crate::ssh::client::ClientHandler;
use russh::client;
use serde::Serialize;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

type Handle = Arc<Mutex<client::Handle<ClientHandler>>>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardMeta {
    pub id: String,
    pub session_id: String,
    pub kind: String, // "local" | "dynamic"
    pub local_port: u16,
    pub remote_host: Option<String>,
    pub remote_port: Option<u16>,
}

async fn bind(local_port: u16) -> Result<TcpListener, AppError> {
    TcpListener::bind(("127.0.0.1", local_port))
        .await
        .map_err(|e| AppError::SshError(format!("Bind 127.0.0.1:{}: {}", local_port, e)))
}

/// Local forward: 127.0.0.1:local_port -> remote_host:remote_port (via SSH).
pub async fn start_local(
    handle: Handle,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Result<JoinHandle<()>, AppError> {
    let listener = bind(local_port).await?;
    Ok(tokio::spawn(async move {
        loop {
            let (mut sock, _) = match listener.accept().await {
                Ok(x) => x,
                Err(_) => break,
            };
            let h = handle.clone();
            let rh = remote_host.clone();
            tokio::spawn(async move {
                let channel = {
                    let g = h.lock().await;
                    g.channel_open_direct_tcpip(rh, remote_port as u32, "127.0.0.1", 0).await
                };
                if let Ok(channel) = channel {
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
                }
            });
        }
    }))
}

/// Dynamic forward: a minimal SOCKS5 (no-auth, CONNECT) proxy on local_port.
pub async fn start_dynamic(handle: Handle, local_port: u16) -> Result<JoinHandle<()>, AppError> {
    let listener = bind(local_port).await?;
    Ok(tokio::spawn(async move {
        loop {
            let (sock, _) = match listener.accept().await {
                Ok(x) => x,
                Err(_) => break,
            };
            let h = handle.clone();
            tokio::spawn(async move {
                let _ = socks5(sock, h).await;
            });
        }
    }))
}

async fn socks5(mut sock: TcpStream, handle: Handle) -> std::io::Result<()> {
    // Greeting: VER, NMETHODS, METHODS...
    let mut head = [0u8; 2];
    sock.read_exact(&mut head).await?;
    if head[0] != 5 {
        return Ok(());
    }
    let mut methods = vec![0u8; head[1] as usize];
    sock.read_exact(&mut methods).await?;
    sock.write_all(&[5, 0]).await?; // choose "no auth"

    // Request: VER, CMD, RSV, ATYP
    let mut req = [0u8; 4];
    sock.read_exact(&mut req).await?;
    if req[1] != 1 {
        // only CONNECT supported
        sock.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        return Ok(());
    }
    let host = match req[3] {
        1 => {
            let mut a = [0u8; 4];
            sock.read_exact(&mut a).await?;
            format!("{}.{}.{}.{}", a[0], a[1], a[2], a[3])
        }
        3 => {
            let mut len = [0u8; 1];
            sock.read_exact(&mut len).await?;
            let mut dom = vec![0u8; len[0] as usize];
            sock.read_exact(&mut dom).await?;
            String::from_utf8_lossy(&dom).to_string()
        }
        4 => {
            let mut a = [0u8; 16];
            sock.read_exact(&mut a).await?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        _ => {
            sock.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            return Ok(());
        }
    };
    let mut port = [0u8; 2];
    sock.read_exact(&mut port).await?;
    let port = u16::from_be_bytes(port);

    let channel = {
        let g = handle.lock().await;
        g.channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0).await
    };
    match channel {
        Ok(channel) => {
            // Success reply (bound addr 0.0.0.0:0).
            sock.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
        }
        Err(_) => {
            sock.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await?; // connection refused
        }
    }
    Ok(())
}
