use super::{Result, remote::interface_name};
use idevice::remote_pairing::{
    PAIRABLE_HOST_SERVICE_TYPE, PairableHost, PairableHostInfo, RpPairingFile, RpPairingSocket,
};
use mdns_sd::{ServiceDaemon, ServiceInfo};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    net::{Ipv4Addr, Ipv6Addr, SocketAddr},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::net::TcpListener;

/// How long wireless pairing waits for the person to finish in Settings.
const PAIRING_LIMIT: Duration = Duration::from_secs(10 * 60);
const SENDING_HOST_KEY: &str = "sending_host";

fn emit(value: Value) {
    println!("{value}");
    let _ = std::io::stdout().flush();
}

fn private_permissions(path: &Path, mode: u32) -> Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("pairing");
    let temporary = path.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
    fs::write(&temporary, bytes)?;
    private_permissions(&temporary, 0o600)?;
    fs::rename(&temporary, path)?;
    Ok(())
}

fn load_host_info(state_dir: &Path, name: &str) -> Result<PairableHostInfo> {
    fs::create_dir_all(state_dir)?;
    private_permissions(state_dir, 0o700)?;
    let key_path = state_dir.join("host-identity.key");
    let mut info = PairableHostInfo::generate(name, "Mac17,7");
    match fs::read(&key_path) {
        Ok(bytes) if bytes.len() == 16 => info.alt_irk.copy_from_slice(&bytes),
        Ok(_) => write_private(&key_path, &info.alt_irk)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            write_private(&key_path, &info.alt_irk)?;
        }
        Err(error) => return Err(error.into()),
    }
    Ok(info)
}

/// The address the phone paired from, in a form `prepare-remote` can save as the remote host.
/// An IPv4-mapped peer becomes plain IPv4. A scoped IPv6 peer (link-local) keeps its interface as
/// `address%interface`: without the zone, a later connection cannot pick the outgoing interface.
fn pairing_peer(peer: SocketAddr) -> String {
    match peer {
        SocketAddr::V4(v4) => v4.ip().to_string(),
        SocketAddr::V6(v6) => {
            if let Some(v4) = v6.ip().to_ipv4_mapped() {
                return v4.to_string();
            }
            match v6.scope_id() {
                0 => v6.ip().to_string(),
                scope => {
                    let zone = interface_name(scope).unwrap_or_else(|| scope.to_string());
                    format!("{}%{zone}", v6.ip())
                }
            }
        }
    }
}

async fn bind_pairing_listener(port: u16) -> Result<TcpListener> {
    match TcpListener::bind((Ipv6Addr::UNSPECIFIED, port)).await {
        Ok(listener) => Ok(listener),
        Err(_) => Ok(TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).await?),
    }
}

/// Why a pairing stopped before the phone finished it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    /// SIGTERM or SIGINT: the daemon cancelled the pairing job, or the person pressed Ctrl-C.
    Signal,
    /// Standard input closed: the process that started this one is gone (a daemon that was killed
    /// hard never sends SIGTERM).
    ParentGone,
    /// Nobody finished pairing in Settings within the limit.
    Timeout,
}

const TIMEOUT_MESSAGE: &str = "Wireless pairing was not finished in Settings within 10 minutes. Run the wireless pairing command again to retry.";
const CANCELLED_MESSAGE: &str = "Wireless pairing was cancelled.";
const PARENT_GONE_MESSAGE: &str =
    "Wireless pairing stopped: the process that started it is gone (its standard input closed).";

/// Resolves once standard input reaches end of file or fails.
async fn input_closed() {
    use tokio::io::AsyncReadExt;
    let mut stdin = tokio::io::stdin();
    let mut buffer = [0u8; 256];
    while matches!(stdin.read(&mut buffer).await, Ok(n) if n > 0) {}
}

/// Everything that ends a pairing early, registered before anything is advertised: a SIGTERM or
/// SIGINT that arrives from now on is recorded and ends the pairing with a goodbye, never by the
/// default disposition. `watch_input`: stop when standard input closes as well.
fn stop_sources(watch_input: bool) -> Result<impl std::future::Future<Output = Stop>> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    Ok(async move {
        let parent = async {
            if watch_input {
                input_closed().await
            } else {
                std::future::pending::<()>().await
            }
        };
        tokio::select! {
            _ = tokio::time::sleep(PAIRING_LIMIT) => Stop::Timeout,
            _ = terminate.recv() => Stop::Signal,
            _ = interrupt.recv() => Stop::Signal,
            _ = parent => Stop::ParentGone,
        }
    })
}

fn pairing_file_bytes(pairing_file: &RpPairingFile, host_name: &str) -> Result<Vec<u8>> {
    let mut dictionary: plist::Dictionary = plist::from_bytes(&pairing_file.to_bytes())?;
    dictionary.insert(SENDING_HOST_KEY.into(), host_name.into());
    let mut bytes = Vec::new();
    plist::to_writer_xml(&mut bytes, &dictionary)?;
    Ok(bytes)
}

/// Advertises this host and waits for one phone to pair, or for `stop`. Whatever ends the wait, the
/// Bonjour service is unregistered (iOS drops it from Settings at once) and the responder shut down
/// before this returns, so a cancelled pairing never leaves a stale "Pair with" entry behind.
async fn pair_host_until(
    state_dir: &str,
    output: &str,
    name: &str,
    port: u16,
    stop: impl std::future::Future<Output = Stop>,
) -> Result<Value> {
    let host_info = load_host_info(Path::new(state_dir), name)?;
    let mut pairing_file = RpPairingFile::generate(name);

    let listener = bind_pairing_listener(port).await?;
    let port = listener.local_addr()?.port();
    let service_identifier = pairing_file.identifier.clone();

    let mdns = ServiceDaemon::new()?;
    let _ = mdns.set_service_name_len_max(30);
    let hostname = format!("poki-{}.local.", &service_identifier[..8]);
    let txt = host_info.mdns_txt_records(&service_identifier);
    let properties: Vec<(&str, &str)> = txt
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    let service_info = ServiceInfo::new(
        PAIRABLE_HOST_SERVICE_TYPE,
        &service_identifier,
        &hostname,
        "",
        port,
        &properties[..],
    )?
    .enable_addr_auto();
    let fullname = service_info.get_fullname().to_string();
    mdns.register(service_info)?;
    emit(json!({
        "event":"advertising",
        "service":PAIRABLE_HOST_SERVICE_TYPE,
        "identifier":service_identifier,
        "port":port,
    }));

    let output_path = PathBuf::from(output);
    let accepted = async {
        let (stream, peer) = listener.accept().await?;
        let peer = pairing_peer(peer);
        emit(json!({"event":"connected","peer":peer}));
        let socket = RpPairingSocket::new_device(stream);
        let mut host = PairableHost::new(socket, host_info);
        let peer_device = host
            .accept(&mut pairing_file, |pin| async move {
                emit(json!({"event":"pin","pin":pin}));
            })
            .await?;
        write_private(&output_path, &pairing_file_bytes(&pairing_file, name)?)?;
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>((peer_device, peer))
    };
    let accepted = tokio::select! {
        result = accepted => Ok(result),
        reason = stop => Err(reason),
    };

    if let Ok(receiver) = mdns.unregister(&fullname) {
        let _ = tokio::task::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(2)))
            .await;
    }
    if let Ok(receiver) = mdns.shutdown() {
        let _ = tokio::task::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(2)))
            .await;
    }
    let (peer_device, peer) = match accepted {
        Ok(result) => result?,
        Err(Stop::Signal) => {
            emit(json!({"event":"cancelled"}));
            return Err(CANCELLED_MESSAGE.into());
        }
        Err(Stop::ParentGone) => {
            emit(json!({"event":"cancelled","reason":"parent_gone"}));
            return Err(PARENT_GONE_MESSAGE.into());
        }
        Err(Stop::Timeout) => {
            emit(json!({"event":"timeout"}));
            return Err(TIMEOUT_MESSAGE.into());
        }
    };
    Ok(json!({
        "event":"paired",
        "device":{
            "udid":peer_device.remotepairing_udid,
            "name":peer_device.name,
            "model":peer_device.model,
        },
        "peer":peer,
    }))
}

/// Pairs until done, cancelled (SIGTERM, SIGINT, standard input closing) or the 10-minute limit.
/// The stop sources exist before the `starting` event, so a caller that waits for it can always
/// cancel cleanly.
pub async fn pair_host(state_dir: &str, output: &str, name: &str, port: u16) -> Result<Value> {
    let stop = stop_sources(true)?;
    emit(json!({"event":"starting"}));
    pair_host_until(state_dir, output, name, port, stop).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv6Addr, SocketAddrV6};

    #[test]
    fn host_identity_is_only_the_alt_irk_and_stays_stable_across_names() {
        let directory =
            std::env::temp_dir().join(format!("poki-pair-host-test-{}", uuid::Uuid::new_v4()));
        let first = load_host_info(&directory, "first-name").unwrap();
        let second = load_host_info(&directory, "second-name").unwrap();
        assert_eq!(first.alt_irk, second.alt_irk);
        assert_eq!(second.name, "second-name");
        assert!(!directory.join("host-identity.plist").exists());
        let key = directory.join("host-identity.key");
        assert_eq!(fs::read(&key).unwrap().len(), 16);
        assert_eq!(
            fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&key).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ipv4_mapped_pairing_peers_are_normalized_for_the_remote_config() {
        let mapped: Ipv6Addr = "192.0.2.10".parse::<Ipv4Addr>().unwrap().to_ipv6_mapped();
        assert_eq!(
            pairing_peer(SocketAddr::V6(SocketAddrV6::new(mapped, 62078, 0, 0))),
            "192.0.2.10"
        );
        assert_eq!(
            pairing_peer("192.0.2.11:62078".parse().unwrap()),
            "192.0.2.11"
        );
        let native_v6: Ipv6Addr = "2001:db8::10".parse().unwrap();
        assert_eq!(
            pairing_peer(SocketAddr::V6(SocketAddrV6::new(native_v6, 62078, 0, 0))),
            "2001:db8::10"
        );
    }

    #[test]
    fn link_local_pairing_peers_keep_their_interface_for_later_connections() {
        let link_local: Ipv6Addr = "fe80::10".parse().unwrap();
        // The loopback interface exists on every host; its index differs between Linux and macOS.
        let loopback = ["lo0", "lo"]
            .iter()
            .find_map(|name| {
                let name = std::ffi::CString::new(*name).unwrap();
                let index = unsafe { libc::if_nametoindex(name.as_ptr()) };
                (index != 0).then_some((index, name.into_string().unwrap()))
            })
            .expect("no loopback interface");
        let peer = pairing_peer(SocketAddr::V6(SocketAddrV6::new(
            link_local, 62078, 0, loopback.0,
        )));
        assert_eq!(peer, format!("fe80::10%{}", loopback.1));
        // A saved host must resolve to the same scoped address the phone paired from.
        let resolved: Vec<SocketAddr> =
            std::net::ToSocketAddrs::to_socket_addrs(&(peer.as_str(), 49152))
                .unwrap()
                .collect();
        assert!(
            resolved
                .iter()
                .any(|address| matches!(address, SocketAddr::V6(v6)
                if *v6.ip() == link_local && v6.scope_id() == loopback.0)),
            "{peer} resolved to {resolved:?}"
        );
        // An interface that vanished still keeps its numeric zone rather than dropping it.
        assert_eq!(
            pairing_peer(SocketAddr::V6(SocketAddrV6::new(
                link_local, 62078, 0, 999_999
            ))),
            "fe80::10%999999"
        );
    }

    #[tokio::test]
    async fn pairing_listener_prefers_a_dual_stack_socket() {
        if std::net::TcpListener::bind((Ipv6Addr::UNSPECIFIED, 0)).is_err() {
            return;
        }
        let listener = bind_pairing_listener(0).await.unwrap();
        let address = listener.local_addr().unwrap();
        assert!(
            address.is_ipv6(),
            "expected a dual-stack IPv6 socket, got {address}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn an_abandoned_pairing_stops_waiting_after_ten_minutes() {
        let started = tokio::time::Instant::now();
        let stop = tokio::select! {
            stop = stop_sources(false).unwrap() => stop,
            _ = tokio::time::sleep(PAIRING_LIMIT * 2) => panic!("the pairing limit never fired"),
        };
        assert_eq!(stop, Stop::Timeout);
        assert_eq!(started.elapsed(), PAIRING_LIMIT);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_pairable_host_advertises_the_service_ios_browses_for() {
        let directory =
            std::env::temp_dir().join(format!("poki-pair-host-mdns-{}", uuid::Uuid::new_v4()));
        let host_name = format!("poki-mdns-test-{}", uuid::Uuid::new_v4());
        let identifier = RpPairingFile::generate(&host_name).identifier().to_string();
        let state = directory.join("state");
        let output = directory.join("pairing.plist");
        let pairing_thread = std::thread::spawn({
            let state = state.clone();
            let output = output.clone();
            let host_name = host_name.clone();
            move || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(async {
                        // Not pair_host: the test's standard input may already be closed.
                        pair_host_until(
                            state.to_str().unwrap(),
                            output.to_str().unwrap(),
                            &host_name,
                            0,
                            stop_sources(false)?,
                        )
                        .await
                    })
            }
        });

        tokio::time::sleep(Duration::from_millis(300)).await;
        let browser = ServiceDaemon::new().unwrap();
        let events = browser.browse(PAIRABLE_HOST_SERVICE_TYPE).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut resolved = None;
        while resolved.is_none() && std::time::Instant::now() < deadline {
            match events.recv_timeout(Duration::from_millis(500)) {
                Ok(mdns_sd::ServiceEvent::ServiceResolved(info))
                    if info.get_fullname().starts_with(&identifier) =>
                {
                    resolved = Some(info);
                }
                _ => {}
            }
        }
        let info = resolved.expect("the pairable host did not resolve over mDNS");
        assert_eq!(
            info.get_property_val_str("identifier"),
            Some(identifier.as_str())
        );
        assert_eq!(info.get_property_val_str("name"), Some(host_name.as_str()));
        assert_eq!(info.get_property_val_str("model"), Some("Mac17,7"));
        assert!(
            info.get_property_val_str("authTag")
                .is_some_and(|tag| !tag.is_empty())
        );
        assert!(info.get_port() > 0);

        // Closing the first connection ends the test pairing immediately instead of waiting ten minutes.
        std::net::TcpStream::connect((Ipv4Addr::LOCALHOST, info.get_port())).unwrap();
        let _ = pairing_thread.join();
        if let Ok(receiver) = browser.shutdown() {
            let _ = receiver.recv_timeout(Duration::from_secs(2));
        }
        let _ = fs::remove_dir_all(directory);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_cancelled_pairing_withdraws_its_bonjour_service() {
        let directory =
            std::env::temp_dir().join(format!("poki-pair-host-cancel-{}", uuid::Uuid::new_v4()));
        let host_name = format!("poki-cancel-test-{}", uuid::Uuid::new_v4());
        let state = directory.join("state");
        let output = directory.join("pairing.plist");
        let (cancel, cancelled) = tokio::sync::oneshot::channel::<()>();
        let pairing_thread = std::thread::spawn({
            let state = state.clone();
            let output = output.clone();
            let host_name = host_name.clone();
            move || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(pair_host_until(
                        state.to_str().unwrap(),
                        output.to_str().unwrap(),
                        &host_name,
                        0,
                        async move {
                            let _ = cancelled.await;
                            Stop::Signal
                        },
                    ))
            }
        });

        let browser = ServiceDaemon::new().unwrap();
        let events = browser.browse(PAIRABLE_HOST_SERVICE_TYPE).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut fullname = None;
        while fullname.is_none() && std::time::Instant::now() < deadline {
            if let Ok(mdns_sd::ServiceEvent::ServiceResolved(info)) =
                events.recv_timeout(Duration::from_millis(500))
                && info.get_property_val_str("name") == Some(host_name.as_str())
            {
                fullname = Some(info.get_fullname().to_string());
            }
        }
        let fullname = fullname.expect("the pairable host did not resolve over mDNS");

        cancel.send(()).unwrap();
        let result = tokio::task::spawn_blocking(move || pairing_thread.join().unwrap())
            .await
            .unwrap();
        assert_eq!(result.unwrap_err().to_string(), CANCELLED_MESSAGE);

        // The goodbye packet reaches browsers: the phone stops offering "Pair with" at once.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut removed = false;
        while !removed && std::time::Instant::now() < deadline {
            if let Ok(mdns_sd::ServiceEvent::ServiceRemoved(_, name)) =
                events.recv_timeout(Duration::from_millis(500))
            {
                removed = name == fullname;
            }
        }
        assert!(removed, "the cancelled pairing left {fullname} advertised");
        assert!(
            !output.exists(),
            "a cancelled pairing wrote a pairing record"
        );
        if let Ok(receiver) = browser.shutdown() {
            let _ = receiver.recv_timeout(Duration::from_secs(2));
        }
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn the_pairing_file_records_the_sending_host_and_still_reads_as_rppairing() {
        let pairing = RpPairingFile::generate("linux-host");
        let bytes = pairing_file_bytes(&pairing, "linux-host").unwrap();
        let dictionary: plist::Dictionary = plist::from_bytes(&bytes).unwrap();
        assert_eq!(
            dictionary
                .get("sending_host")
                .and_then(plist::Value::as_string),
            Some("linux-host")
        );
        let reread = RpPairingFile::from_bytes(&bytes).unwrap();
        assert_eq!(reread.identifier(), pairing.identifier());
        assert_eq!(reread.public_key_bytes(), pairing.public_key_bytes());
        assert_eq!(reread.private_key_bytes(), pairing.private_key_bytes());
    }
}
