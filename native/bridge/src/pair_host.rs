use super::Result;
use idevice::remote_pairing::{
    PAIRABLE_HOST_SERVICE_TYPE, PairableHost, PairableHostInfo, RpPairingFile, RpPairingSocket,
};
use mdns_sd::{ServiceDaemon, ServiceInfo};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
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

fn pairing_peer_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(address) => address
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(address)),
        ipv4 => ipv4,
    }
}

async fn bind_pairing_listener(port: u16) -> Result<TcpListener> {
    match TcpListener::bind((Ipv6Addr::UNSPECIFIED, port)).await {
        Ok(listener) => Ok(listener),
        Err(_) => Ok(TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).await?),
    }
}

async fn with_pairing_limit<T>(future: impl std::future::Future<Output = Result<T>>) -> Result<T> {
    match tokio::time::timeout(PAIRING_LIMIT, future).await {
        Ok(result) => result,
        Err(_) => Err(
            "Wireless pairing was not finished in Settings within 10 minutes. Run the wireless pairing command again to retry."
                .into(),
        ),
    }
}

fn pairing_file_bytes(pairing_file: &RpPairingFile, host_name: &str) -> Result<Vec<u8>> {
    let mut dictionary: plist::Dictionary = plist::from_bytes(&pairing_file.to_bytes())?;
    dictionary.insert(SENDING_HOST_KEY.into(), host_name.into());
    let mut bytes = Vec::new();
    plist::to_writer_xml(&mut bytes, &dictionary)?;
    Ok(bytes)
}

async fn pair_host_once(state_dir: &str, output: &str, name: &str, port: u16) -> Result<Value> {
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
        let peer_ip = pairing_peer_ip(peer.ip());
        emit(json!({"event":"connected","peer":peer_ip.to_string()}));
        let socket = RpPairingSocket::new_device(stream);
        let mut host = PairableHost::new(socket, host_info);
        let peer_device = host
            .accept(&mut pairing_file, |pin| async move {
                emit(json!({"event":"pin","pin":pin}));
            })
            .await?;
        write_private(&output_path, &pairing_file_bytes(&pairing_file, name)?)?;
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>((peer_device, peer_ip.to_string()))
    }
    .await;

    if let Ok(receiver) = mdns.shutdown() {
        let _ = tokio::task::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(2)))
            .await;
    }
    let (peer_device, peer) = accepted?;
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

pub async fn pair_host(state_dir: &str, output: &str, name: &str, port: u16) -> Result<Value> {
    with_pairing_limit(pair_host_once(state_dir, output, name, port)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv6Addr;

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
            pairing_peer_ip(std::net::IpAddr::V6(mapped)),
            std::net::IpAddr::V4("192.0.2.10".parse().unwrap())
        );
        let native_v6: Ipv6Addr = "2001:db8::10".parse().unwrap();
        assert_eq!(
            pairing_peer_ip(std::net::IpAddr::V6(native_v6)),
            std::net::IpAddr::V6(native_v6)
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
        let result = with_pairing_limit(std::future::pending::<Result<Value>>()).await;
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("not finished in Settings within 10 minutes")
        );
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
                    .block_on(pair_host(
                        state.to_str().unwrap(),
                        output.to_str().unwrap(),
                        &host_name,
                        0,
                    ))
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
