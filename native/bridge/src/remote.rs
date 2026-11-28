#[cfg(not(test))]
use super::connect_device;
use super::{
    InputMedia, NoDisplayService, NotSent, Request, Result, close_input, execute, execute_connected,
    video::VideoHub,
};
use std::sync::Arc;
use idevice::{
    remote_pairing::{
        RemotePairingClient, RpPairingFile, RpPairingSocket, connect_tls_psk_tunnel_native,
    },
    rsd::RsdHandshake,
    tcp::handle::AdapterHandle,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    io::Write,
    net::{IpAddr, SocketAddr},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    net::TcpStream,
};

#[derive(Deserialize)]
struct Config {
    id: String,
    host: String,
    port: u16,
    pairing_file: String,
}

impl Config {
    fn uses_bonjour(&self) -> bool {
        // A zone identifier may itself end in .local; numeric IPv6 remains numeric.
        let address = self
            .host
            .split_once('%')
            .map_or(self.host.as_str(), |(address, _)| address);
        if address.parse::<IpAddr>().is_ok() {
            return false;
        }
        let host = self.host.strip_suffix('.').unwrap_or(&self.host);
        host.to_ascii_lowercase().ends_with(".local")
    }
}

struct Control {
    client: RemotePairingClient<RpPairingSocket<TcpStream>>,
    peer: SocketAddr,
}

impl Control {
    async fn open_data_socket(&self, port: u16) -> std::io::Result<TcpStream> {
        let mut endpoint = self.peer;
        endpoint.set_port(port);
        TcpStream::connect(endpoint).await
    }
}

enum Transport {
    Local(String),
    Remote(Config),
}

struct Connection {
    adapter: AdapterHandle,
    rsd: RsdHandshake,
    rsd_port: u16,
    provider: Option<idevice::provider::UsbmuxdProvider>,
    media: Option<InputMedia>,
}

struct Session {
    transport: Transport,
    control: Option<Control>,
    connection: Option<Connection>,
    stream: Streaming,
}

/// The screen video of this helper's phone. Its subscribers keep the media session open, and
/// reopen it when it drops (`Session::maintain`).
#[derive(Default)]
struct Streaming {
    hub: Arc<VideoHub>,
    /// When a failed reopen may be tried again, and how long to wait after the next failure.
    retry_at: Option<tokio::time::Instant>,
    backoff: Duration,
    panels_checked_at: Option<tokio::time::Instant>,
    restarted_at: Option<tokio::time::Instant>,
    /// Whether a viewer was subscribed when last looked (`notice_viewers`).
    watched: bool,
}

/// While subscribed, the session checks its media this often.
const STREAM_MAINTENANCE: Duration = Duration::from_millis(500);
/// A phone with several panels is asked which one is active this often while subscribed.
const PANEL_CHECK: Duration = Duration::from_secs(2);
/// An unanswered keyframe request restarts the media session at most this often.
const MEDIA_RESTART: Duration = Duration::from_secs(5);

impl Session {
    async fn connect(&mut self) -> Result<()> {
        let config = match &self.transport {
            Transport::Local(udid) => {
                // Without a phone, tests hand out tunnels they can unplug.
                #[cfg(test)]
                let connection = tests::connect_local(udid).await?;
                #[cfg(not(test))]
                let connection = {
                    let (adapter, rsd, rsd_port, provider) = connect_device(udid).await?;
                    Connection {
                        adapter,
                        rsd,
                        rsd_port,
                        provider: Some(provider),
                        media: None,
                    }
                };
                self.connection = Some(connection);
                return Ok(());
            }
            Transport::Remote(config) => config,
        };
        if self.control.is_none() {
            let socket = dial(&config.host, config.port).await
                .map_err(|attempts| format!("Remote pairing is unreachable ({attempts}). Keep the iPhone unlocked and check its configured address or Bonjour name; for Tailscale, keep both devices connected."))?;
            socket.set_nodelay(true)?;
            let peer = socket.peer_addr()?;
            let pairing_bytes = tokio::fs::read(&config.pairing_file).await?;
            let sending_host =
                pairing_sending_host(&pairing_bytes).unwrap_or_else(|| "poki-mcp".into());
            let mut control = RemotePairingClient::new(RpPairingSocket::new(socket), &sending_host);
            let mut record = RpPairingFile::from_bytes(&pairing_bytes)?;
            control.attempt_pair_verify().await?;
            // Never fall back to pairing or request consent during an ordinary operation.
            control.validate_pairing(&mut record).await?;
            self.control = Some(Control {
                client: control,
                peer,
            });
        }
        let control = self.control.as_mut().unwrap();
        let port = match control.client.create_tcp_listener().await {
            Ok(port) => port,
            Err(error) => {
                self.control = None;
                return Err(format!("The remote pairing control connection closed: {error}. Reconnect the iPhone to Wi-Fi, then reconnect the device.").into());
            }
        };
        // Use the authenticated control peer, including its IPv6 scope. A
        // second hostname lookup could select a different address mid-session.
        let socket = control.open_data_socket(port).await
            .map_err(|_| "The iPhone refused a new tunnel. Reconnect it to Wi-Fi, then reconnect the device.")?;
        socket.set_nodelay(true)?;
        let tunnel = connect_tls_psk_tunnel_native(socket, control.client.encryption_key()).await?;
        let info = tunnel.info.clone();
        let mut adapter = idevice::tcp::adapter::Adapter::new(
            Box::new(tunnel.into_inner()),
            info.client_address.parse()?,
            info.server_address.parse()?,
        )
        .to_async_handle();
        let rsd = RsdHandshake::new(adapter.connect(info.server_rsd_port).await?).await?;
        if rsd
            .properties
            .get("UniqueDeviceID")
            .and_then(plist::Value::as_string)
            != Some(config.id.as_str())
        {
            return Err("Remote device identity does not match the configured iPhone".into());
        }
        self.connection = Some(Connection {
            adapter,
            rsd,
            rsd_port: info.server_rsd_port,
            provider: None,
            media: None,
        });
        Ok(())
    }

    fn input_media_deadline(&self) -> Option<tokio::time::Instant> {
        let media = self.connection.as_ref()?.media.as_ref()?;
        if media.streaming() {
            return None;
        }
        Some(
            (media.last_activity + INPUT_MEDIA_IDLE_TIMEOUT)
                .min(media.last_input + INPUT_MEDIA_MAX_READ_HOLD),
        )
    }

    /// Ends the input hold. The media session stays open while someone watches the screen.
    async fn release_input(&mut self) -> Result<()> {
        if self.stream.hub.subscribers() > 0 {
            return Ok(());
        }
        self.close_media().await
    }

    async fn close_media(&mut self) -> Result<()> {
        if let Some(connection) = &mut self.connection {
            close_input(&mut connection.media).await?;
        }
        Ok(())
    }

    /// Opens the tunnel and the media session the screen video comes from, if not open yet.
    async fn ensure_media(&mut self) -> Result<()> {
        if self
            .connection
            .as_ref()
            .and_then(|c| c.media.as_ref())
            .is_some_and(|m| !m.alive())
        {
            let _ = self.close_media().await;
        }
        if self.connection.is_none() {
            self.open().await?;
        }
        let connection = self.connection.as_mut().unwrap();
        if connection.media.is_none() {
            let started = tokio::time::timeout(
                Duration::from_secs(25),
                InputMedia::connect(&mut connection.adapter, &mut connection.rsd, &self.stream.hub),
            )
            .await
            .unwrap_or_else(|_| Err("Starting the screen video timed out".into()));
            let error = match started {
                Ok(media) => {
                    connection.media = Some(media);
                    self.stream.hub.clear_keyframe_request();
                    return Ok(());
                }
                Err(error) => error,
            };
            // A tunnel that died (a pulled cable, a phone gone from Wi-Fi) is dropped, so the next
            // attempt builds a new one; a live tunnel that only refused the service is kept, as the
            // request path does.
            let closed = connection.adapter.bind_udp(0).await.is_err()
                || (socket_failure(error.as_ref())
                    && connection.adapter.connect(connection.rsd_port).await.is_err());
            if closed {
                self.connection = None;
                if matches!(&self.transport, Transport::Remote(config) if config.uses_bonjour()) {
                    self.control = None;
                }
            }
            return Err(error);
        }
        Ok(())
    }

    /// After the last viewer leaves, the session idles as after an input: it is released
    /// INPUT_MEDIA_IDLE_TIMEOUT later, not at once for an input long ago.
    fn notice_viewers(&mut self) {
        let watched = self.stream.hub.subscribers() > 0;
        if self.stream.watched
            && !watched
            && let Some(media) = self.connection.as_mut().and_then(|c| c.media.as_mut())
        {
            let now = tokio::time::Instant::now();
            media.last_activity = now;
            media.last_input = media.last_input.max(now);
        }
        self.stream.watched = watched;
    }

    /// When the subscribed stream next needs looking after.
    fn maintenance_due(&self) -> Option<tokio::time::Instant> {
        if self.stream.hub.subscribers() == 0 {
            return None;
        }
        let now = tokio::time::Instant::now();
        Some(match self.stream.retry_at {
            Some(at) if at > now => at,
            _ => now + STREAM_MAINTENANCE,
        })
    }

    /// While someone watches: reopens a media session that dropped (with backoff), restarts one
    /// whose keyframe request went unanswered (a new session starts with a key frame), and
    /// follows a fold or panel switch to the active panel.
    async fn maintain(&mut self) {
        if self.stream.hub.subscribers() == 0 {
            return;
        }
        let now = tokio::time::Instant::now();
        let mut restart = self.stream.hub.keyframe_overdue(now)
            && self
                .stream
                .restarted_at
                .is_none_or(|at| now.duration_since(at) >= MEDIA_RESTART);
        if let Some(connection) = self.connection.as_mut()
            && let Some(media) = connection.media.as_ref()
            && super::display::several_known(&connection.rsd)
            && self
                .stream
                .panels_checked_at
                .is_none_or(|at| now.duration_since(at) >= PANEL_CHECK)
        {
            self.stream.panels_checked_at = Some(now);
            let shown = media.display_id;
            if let Ok(display) =
                super::display::active(&mut connection.adapter, &connection.rsd).await
                && super::display::route(display.as_ref()).media_display != shown
            {
                restart = true;
            }
        }
        if restart {
            self.stream.restarted_at = Some(now);
            let _ = self.close_media().await;
        }
        let healthy = self
            .connection
            .as_ref()
            .and_then(|c| c.media.as_ref())
            .is_some_and(InputMedia::alive);
        if healthy || self.stream.retry_at.is_some_and(|at| at > now) {
            return;
        }
        match Box::pin(self.ensure_media()).await {
            Ok(()) => {
                self.stream.retry_at = None;
                self.stream.backoff = Duration::ZERO;
            }
            Err(_) => {
                self.stream.backoff = (self.stream.backoff * 2)
                    .clamp(Duration::from_secs(1), Duration::from_secs(5));
                self.stream.retry_at = Some(tokio::time::Instant::now() + self.stream.backoff);
            }
        }
    }

    async fn request(&mut self, request: Value) -> Result<Value> {
        self.notice_viewers();
        if self
            .input_media_deadline()
            .is_some_and(|deadline| tokio::time::Instant::now() >= deadline)
        {
            let _ = self.release_input().await;
        }
        if request["op"] == "release_input" {
            self.release_input().await?;
            return Ok(json!({"released":true}));
        }
        if request["op"] == "media_keyframe" {
            // Answered by the pump (PLI and FIR, at most once a second). A phone that ignores it
            // gets a restarted media session from `maintain`.
            let open = self
                .connection
                .as_ref()
                .and_then(|c| c.media.as_ref())
                .is_some_and(InputMedia::alive);
            if open {
                self.stream.hub.want_keyframe();
            }
            return Ok(json!({"requested":open,"subscribers":self.stream.hub.subscribers()}));
        }
        if request["op"] == "ddi_status" || request["op"] == "install_ddi" {
            return self.developer_disk_image(&request).await;
        }
        let action = if request["op"] == "connect" || request["op"] == "reconnect" {
            None
        } else {
            let parsed: Result<Request> =
                serde_json::from_value(request.clone()).map_err(Into::into);
            let action = match parsed.and_then(|action| action.validate().map(|()| action)) {
                Ok(action) => action,
                Err(error) => return refused_reply(&request, error),
            };
            if matches!(
                action,
                Request::InstallApp { .. } | Request::UninstallApp { .. }
            ) {
                let _ = self.release_input().await;
                return match &self.transport {
                    Transport::Local(udid) => execute(udid, action).await,
                    Transport::Remote(_) => {
                        Err("App installation over remote pairing is not supported".into())
                    }
                };
            }
            Some(action)
        };
        let Some(action) = action else {
            // Keep the working tunnel until its replacement has actually connected.
            // A failed reconnect must not destroy the only usable cellular session.
            if self.connection.is_none() || request["op"] == "reconnect" {
                let _ = self.close_media().await;
                if request["op"] == "reconnect"
                    && matches!(&self.transport, Transport::Remote(config) if config.uses_bonjour())
                {
                    self.control = None;
                }
                self.open().await?;
            }
            return Ok(
                json!({"connected":true,"transport":match &self.transport { Transport::Local(_) => "local", Transport::Remote(_) => "remote_pairing" },"device":match &self.transport { Transport::Local(id) => id, Transport::Remote(config) => &config.id }}),
            );
        };
        let local_read = matches!(self.transport, Transport::Local(_)) && action.read_only();
        // A tunnel can die while the helper idles: a pulled cable or a restarted phone leaves its adapter closed.
        // Until an input is written nothing can repeat, so the request rebuilds a closed tunnel once and tries again.
        let mut fresh = false;
        loop {
            if self.connection.is_none() {
                if let Err(error) = self.open().await {
                    return unsent_reply(&action, error);
                }
                fresh = true;
            }
            let hub = self.stream.hub.clone();
            let Connection {
                adapter,
                rsd,
                rsd_port,
                provider,
                media,
            } = self.connection.as_mut().unwrap();
            let result = tokio::time::timeout(
                Duration::from_secs(90),
                execute_connected(
                    adapter,
                    rsd,
                    provider
                        .as_ref()
                        .map(|p| p as &dyn idevice::provider::IdeviceProvider),
                    action.clone(),
                    media,
                    &hub,
                ),
            )
            .await;
            let error = match result {
                Ok(Ok(value)) => {
                    if !action.uses_input_media()
                        && value["outcome"] != "not_sent"
                        && value["sent"] != false
                        && let Some(m) = media.as_mut()
                    {
                        m.last_activity = tokio::time::Instant::now();
                    }
                    if self
                        .input_media_deadline()
                        .is_some_and(|deadline| tokio::time::Instant::now() >= deadline)
                    {
                        let _ = self.release_input().await;
                    }
                    return Ok(value);
                }
                Ok(Err(error)) => error,
                Err(_) => "Remote operation timed out".into(),
            };
            // A failed request resets the media session, unless someone watches the screen
            // through it; a dead tunnel below drops it either way.
            if !media.as_ref().is_some_and(InputMedia::streaming) {
                let _ = close_input(media).await;
            }
            // A service or file error does not imply the shared tunnel died.
            // bind_udp checks the adapter task locally without opening a phone service.
            // A phone that vanished without a reset leaves the adapter running, so a socket error also
            // asks the phone for its RSD port.
            let closed = adapter.bind_udp(0).await.is_err()
                || (socket_failure(error.as_ref()) && adapter.connect(*rsd_port).await.is_err());
            let not_sent = error.is::<NotSent>();
            // Only a dead tunnel is replaced. A live one stays, since a cellular replacement may be refused.
            if closed {
                self.connection = None;
                // Hostname mode must resolve again rather than dial the old
                // control peer. Preserve legacy IP/Tailscale control reuse.
                if matches!(&self.transport, Transport::Remote(config) if config.uses_bonjour()) {
                    self.control = None;
                }
                if (not_sent || action.read_only()) && !fresh {
                    continue;
                }
            }
            if not_sent || (closed && action.read_only()) {
                return unsent_reply(&action, error);
            }
            // Delivery can be ambiguous: the caller must inspect, never replay automatically.
            if local_read {
                return Err(error);
            }
            return Err(format!(
                "{error}. Input may have been delivered; inspect the screen before retrying."
            )
            .into());
        }
    }

    // ddi_status and install_ddi (ddi.rs). Neither sends input. An installation adds services the
    // current handshake does not list, so the tunnel is reopened afterwards and the reply reports
    // displayservice as the phone now offers it.
    async fn developer_disk_image(&mut self, request: &Value) -> Result<Value> {
        let install = request["op"] == "install_ddi";
        let restore_dir = request["restore_dir"].as_str().map(str::to_owned);
        if install
            && !restore_dir
                .as_deref()
                .is_some_and(|dir| dir.starts_with('/'))
        {
            return Err(
                "install_ddi needs restore_dir: an absolute path to the image directory.".into(),
            );
        }
        let force = request["force"].as_bool().unwrap_or(false);
        // Only an installation disturbs the phone's input session; a status read leaves it open.
        if install {
            let _ = self.release_input().await;
        }
        if self.connection.is_none() {
            self.open().await?;
        }
        let Connection { adapter, rsd, .. } = self.connection.as_mut().unwrap();
        if !install {
            let services_only = request["services_only"].as_bool().unwrap_or(false);
            return Ok(super::ddi::status(adapter, rsd, services_only).await);
        }
        let mut reply = tokio::time::timeout(
            Duration::from_secs(15 * 60),
            super::ddi::install(adapter, rsd, restore_dir.as_deref().unwrap(), force),
        )
        .await
        .unwrap_or_else(|_| json!({"installed": false, "stage": "install", "error": "Installing the developer disk image did not finish within 15 minutes."}));
        if reply["installed"] == true && reply["already"] != true {
            self.connection = None;
            if matches!(&self.transport, Transport::Remote(config) if config.uses_bonjour()) {
                self.control = None;
            }
            self.open().await?;
        }
        let rsd = &self.connection.as_ref().unwrap().rsd;
        reply["display_service"] = json!(rsd.services.contains_key(super::ddi::DISPLAY_SERVICE));
        Ok(reply)
    }

    async fn open(&mut self) -> Result<()> {
        let connected = match tokio::time::timeout(Duration::from_secs(25), self.connect()).await {
            Ok(connected) => connected,
            Err(timeout) => Err(timeout.into()),
        };
        if connected.is_err() {
            self.control = None;
        }
        connected
    }
}

// Tries every resolved address in order, as a host-and-port connect does, but keeps
// each address's OS error: the last error alone cannot tell routing from policy.
async fn dial(host: &str, port: u16) -> std::result::Result<TcpStream, String> {
    let addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| format!("{host} did not resolve: {error}"))?;
    let mut attempts = Vec::new();
    for address in addresses {
        match TcpStream::connect(address).await {
            Ok(socket) => return Ok(socket),
            Err(error) => attempts.push(format!("{}: {error}", endpoint(address))),
        }
    }
    if attempts.is_empty() {
        return Err(format!("{host} resolved to no address"));
    }
    Err(attempts.join("; "))
}

// Names an IPv6 scope by its interface, so a link-local attempt shows which network it used.
fn endpoint(address: SocketAddr) -> String {
    let SocketAddr::V6(v6) = address else {
        return address.to_string();
    };
    match (v6.scope_id() != 0).then(|| interface_name(v6.scope_id())).flatten() {
        Some(interface) => format!("[{}%{interface}]:{}", v6.ip(), v6.port()),
        None => address.to_string(),
    }
}

/// The name of the interface with this index, such as `en0` or `wlan0`.
pub(crate) fn interface_name(index: u32) -> Option<String> {
    let mut name = [0 as libc::c_char; libc::IF_NAMESIZE];
    if unsafe { libc::if_indextoname(index, name.as_mut_ptr()) }.is_null() {
        return None;
    }
    Some(
        unsafe { std::ffi::CStr::from_ptr(name.as_ptr()) }
            .to_string_lossy()
            .into_owned(),
    )
}

fn socket_failure(error: &(dyn std::error::Error + Send + Sync + 'static)) -> bool {
    match error.downcast_ref::<NotSent>() {
        Some(NotSent(error)) => socket_failure(error.as_ref()),
        None => {
            error.is::<std::io::Error>()
                || matches!(
                    error.downcast_ref::<idevice::IdeviceError>(),
                    Some(idevice::IdeviceError::Socket(_))
                )
        }
    }
}

// The reply for a request whose input never reached the phone.
fn unsent_reply(
    action: &Request,
    error: Box<dyn std::error::Error + Send + Sync>,
) -> Result<Value> {
    match action {
        Request::LaunchApp(_) => Ok(super::apps::not_sent(error)),
        Request::Configuration { .. } => Err(error),
        action if action.read_only() => Err(error),
        _ => {
            let mut reply = json!({"isError":true,"outcome":"not_sent","stop_reason":"error","sent":false,"screen_change_verified":false,"error":error.to_string(),"instruction":"Nothing reached the iPhone. Keep it connected and unlocked, then retry."});
            if error
                .downcast_ref::<NotSent>()
                .is_some_and(|error| error.0.is::<NoDisplayService>())
            {
                reply["reason"] = "display_service_missing".into();
            }
            Ok(reply)
        }
    }
}

// The reply for a request refused before connecting, so before anything could reach the phone.
fn refused_reply(
    request: &Value,
    error: Box<dyn std::error::Error + Send + Sync>,
) -> Result<Value> {
    match request["op"].as_str() {
        Some("launch_app") => Ok(super::apps::not_sent(error)),
        // Reads, settings and app installs report a refusal as an error, as they report any other failure.
        Some(
            "ax_tree" | "screenshot" | "device_info" | "display_info" | "list_apps"
            | "configuration" | "install_app" | "uninstall_app",
        ) => Err(error),
        _ => Ok(
            json!({"isError":true,"outcome":"not_sent","stop_reason":"error","sent":false,"screen_change_verified":false,"error":error.to_string(),"instruction":"Nothing was sent to the iPhone: the helper refused this request before any input. Correct the request before retrying."}),
        ),
    }
}

fn pairing_sending_host(bytes: &[u8]) -> Option<String> {
    plist::from_bytes::<plist::Dictionary>(bytes)
        .ok()?
        .get("sending_host")
        .and_then(plist::Value::as_string)
        .map(str::to_owned)
}

fn load(path: &str) -> Result<Session> {
    Ok(Session {
        transport: Transport::Remote(serde_json::from_slice(&std::fs::read(path)?)?),
        control: None,
        connection: None,
        stream: Streaming::default(),
    })
}

async fn reply(session: &mut Session, line: &str) -> Value {
    let response = if line.len() > 2 * 1024 * 1024 {
        Err("Remote request exceeds size limit".into())
    } else {
        match serde_json::from_str::<Value>(line) {
            Ok(request) => Box::pin(session.request(request)).await,
            Err(e) => Err(e.into()),
        }
    };
    response.unwrap_or_else(|e| json!({"isError":true,"transport_error":true,"error":e.to_string(),"screen_change_verified":false}))
}

const INPUT_MEDIA_IDLE_TIMEOUT: Duration = Duration::from_secs(1);
pub(super) const INPUT_MEDIA_MAX_READ_HOLD: Duration = Duration::from_secs(5);

async fn sleep_until(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending::<()>().await,
    }
}

/// Runs `future` while the session idles: releases idle input media on time and, while someone
/// watches the screen, keeps its media session open. The deadlines are taken again whenever a
/// subscriber comes or goes, so the last one leaving starts the idle release.
async fn with_media_deadline<T>(
    session: &mut Session,
    future: impl std::future::Future<Output = T>,
) -> T {
    tokio::pin!(future);
    let mut subscribers = session.stream.hub.watch();
    loop {
        session.notice_viewers();
        if session
            .input_media_deadline()
            .is_some_and(|deadline| tokio::time::Instant::now() >= deadline)
        {
            let _ = session.release_input().await;
        }
        let deadline = session.input_media_deadline();
        let maintenance = session.maintenance_due();
        subscribers.borrow_and_update();
        tokio::select! {
            biased;
            output = &mut future => return output,
            () = sleep_until(deadline) => {
                let _ = session.release_input().await;
            }
            changed = subscribers.changed() => {
                if changed.is_err() {
                    return future.await;
                }
            }
            // Boxed: inline, the maintenance future overflowed a debug test thread's stack.
            () = sleep_until(maintenance) => Box::pin(session.maintain()).await,
        }
    }
}

pub async fn serve(path: &str) -> Result<Value> {
    use tokio::io::AsyncWriteExt;
    let mut session = load(path)?;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = with_media_deadline(&mut session, lines.next_line()).await? {
        let output = reply(&mut session, &line).await;
        let mut bytes = serde_json::to_vec(&output)?;
        bytes.push(b'\n');
        with_media_deadline(&mut session, async {
            stdout.write_all(&bytes).await?;
            stdout.flush().await
        })
        .await?;
    }
    session.stream.hub.close();
    let _ = session.close_media().await;
    Ok(json!({"closed":true}))
}

pub async fn serve_socket(path: &str, socket_path: &str) -> Result<Value> {
    serve_session(load(path)?, socket_path).await
}

pub async fn serve_local(udid: &str, socket_path: &str) -> Result<Value> {
    // EOF means the owning daemon is gone, including crashes without a shutdown hook.
    let owned_path = socket_path.to_owned();
    tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut byte = [0u8; 1];
        let _ = tokio::io::stdin().read(&mut byte).await;
        let _ = std::fs::remove_file(owned_path);
        std::process::exit(0);
    });
    serve_session(
        Session {
            transport: Transport::Local(udid.into()),
            control: None,
            connection: None,
            stream: Streaming::default(),
        },
        socket_path,
    )
    .await
}

/// `media_subscribe`: opens the screen video and hands this connection to a task that streams
/// frames on it (video.rs has the format), so the helper goes on serving other requests. The
/// connection stays the subscriber's until either side closes it.
async fn subscribe(
    session: &mut Session,
    mut stream: BufReader<tokio::net::UnixStream>,
) {
    use tokio::io::AsyncWriteExt;
    // Counted before the media opens, so nothing releases it while it starts.
    let subscription = session.stream.hub.subscribe();
    let opened = Box::pin(session.ensure_media()).await;
    let reply = match &opened {
        Ok(()) => {
            let size = session.stream.hub.size();
            json!({"subscribed":true,"codec":"hevc","width":size.map(|s| s.0),"height":size.map(|s| s.1)})
        }
        Err(error) => {
            let mut reply = json!({"isError":true,"subscribed":false,"error":error.to_string()});
            if error.is::<NoDisplayService>() {
                reply["reason"] = "display_service_missing".into();
            }
            reply
        }
    };
    let mut bytes = serde_json::to_vec(&reply).unwrap_or_default();
    bytes.push(b'\n');
    let written = tokio::time::timeout(Duration::from_secs(5), stream.get_mut().write_all(&bytes))
        .await
        .is_ok_and(|r| r.is_ok());
    if opened.is_err() || !written {
        return;
    }
    tokio::spawn(async move {
        let mut socket = stream.into_inner();
        subscription.serve(&mut socket).await;
    });
}

async fn serve_session(mut session: Session, socket_path: &str) -> Result<Value> {
    use std::os::unix::fs::PermissionsExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::UnixListener::bind(socket_path)?;
    std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o600))?;
    println!("{}", json!({"ready":true}));
    std::io::stdout().flush()?;
    loop {
        let (mut socket, _) = with_media_deadline(&mut session, listener.accept()).await?;
        let Some((mut stream, line)) = with_media_deadline(&mut session, async {
            let hello = format!("{}\n", json!({"pid":std::process::id()}));
            if socket.write_all(hello.as_bytes()).await.is_err() {
                return None;
            }
            let mut stream = BufReader::new(socket);
            let mut line = String::new();
            // The local directory is private. Bound incomplete requests so an abandoned client cannot hold the device.
            if !matches!(
                tokio::time::timeout(
                    Duration::from_secs(5),
                    (&mut stream).take(2 * 1024 * 1024 + 1).read_line(&mut line),
                )
                .await,
                Ok(Ok(n)) if n > 0
            ) {
                return None;
            }
            if line.len() > 2 * 1024 * 1024 {
                return None;
            }
            Some((stream, line))
        })
        .await
        else {
            continue;
        };
        if serde_json::from_str::<Value>(&line)
            .ok()
            .is_some_and(|v| v["op"] == "disconnect")
        {
            stream
                .get_mut()
                .write_all(b"{\"disconnected\":true}\n")
                .await?;
            break;
        }
        if serde_json::from_str::<Value>(&line)
            .ok()
            .is_some_and(|v| v["op"] == "media_subscribe")
        {
            subscribe(&mut session, stream).await;
            continue;
        }
        let request = serde_json::from_str::<Request>(&line);
        let screenshot_path = match &request {
            Ok(Request::Screenshot { path }) => Some(path),
            _ => None,
        };
        let read_only = request.as_ref().is_ok_and(Request::read_only);
        let previous_activity = session
            .connection
            .as_ref()
            .and_then(|c| c.media.as_ref())
            .map(|m| m.last_activity);
        let mut byte = [0u8; 1];
        let (output, abandoned) = if read_only {
            // Draining an observation preserves service framing when its caller stops waiting.
            let response = reply(&mut session, &line);
            tokio::pin!(response);
            tokio::select! {
                biased;
                _ = stream.read(&mut byte) => (response.await, true),
                output = &mut response => (output, false),
            }
        } else {
            let result = tokio::select! {
                biased;
                _ = stream.read(&mut byte) => None,
                output = reply(&mut session, &line) => Some(output),
            };
            match result {
                Some(output) => (output, false),
                None => {
                    let _ = session.release_input().await;
                    continue;
                }
            }
        };
        if abandoned {
            if let (Some(previous), Some(media)) = (
                previous_activity,
                session.connection.as_mut().and_then(|c| c.media.as_mut()),
            ) {
                media.last_activity = previous;
            }
            if session
                .input_media_deadline()
                .is_some_and(|deadline| tokio::time::Instant::now() >= deadline)
            {
                let _ = session.release_input().await;
            }
        }
        let mut bytes = serde_json::to_vec(&output)?;
        bytes.push(b'\n');
        let delivered = !abandoned
            && matches!(
                with_media_deadline(
                    &mut session,
                    tokio::time::timeout(
                        Duration::from_secs(5),
                        stream.get_mut().write_all(&bytes),
                    ),
                )
                .await,
                Ok(Ok(()))
            );
        if !delivered && output["saved"] == true {
            if let Some(path) = screenshot_path {
                let _ = tokio::fs::remove_file(path).await;
            }
        }
    }
    session.stream.hub.close();
    let _ = session.close_media().await;
    let _ = std::fs::remove_file(socket_path);
    Ok(json!({"closed":true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use idevice::{
        ReadWrite, RsdService as _,
        core_device::{AppServiceClient, DisplayServiceClient},
        rsd::RsdService,
        tcp::packets::{Ipv6Packet, ProtocolNumber, TcpFlags, TcpPacket},
    };
    use std::{
        cell::RefCell,
        collections::HashMap,
        net::{IpAddr, Ipv6Addr},
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt, DuplexStream},
        sync::mpsc,
    };

    thread_local! {
        // Receives the phone end of every tunnel the session builds.
        static PHONE: RefCell<Option<mpsc::UnboundedSender<DuplexStream>>> = const { RefCell::new(None) };
    }

    fn tunnel() -> (Connection, DuplexStream) {
        let (host, phone) = tokio::io::duplex(1 << 16);
        let adapter = idevice::tcp::adapter::Adapter::new(
            Box::new(host),
            "fd00::1".parse().unwrap(),
            "fd00::2".parse().unwrap(),
        )
        .to_async_handle();
        let services = [
            DisplayServiceClient::<Box<dyn ReadWrite>>::rsd_service_name().to_string(),
            AppServiceClient::<Box<dyn ReadWrite>>::rsd_service_name().to_string(),
            "com.apple.accessibility.axAuditDaemon.remoteAXService".to_string(),
            crate::Hid::rsd_service_name().to_string(),
            "com.apple.coredevice.deviceinfo".to_string(),
        ]
        .into_iter()
        .zip(50000u16..)
        .map(|(name, port)| {
            let service = RsdService {
                entitlement: String::new(),
                port,
                uses_remote_xpc: true,
                features: None,
                service_version: None,
            };
            (name, service)
        })
        .collect();
        let rsd = RsdHandshake {
            services,
            protocol_version: 2,
            properties: HashMap::new(),
            uuid: String::new(),
        };
        let connection = Connection {
            adapter,
            rsd,
            rsd_port: 58783,
            provider: None,
            media: None,
        };
        (connection, phone)
    }

    pub(super) async fn connect_local(_udid: &str) -> Result<Connection> {
        let (connection, phone) = tunnel();
        PHONE.with(|sender| sender.borrow().as_ref().map(|sender| sender.send(phone)));
        Ok(connection)
    }

    // A cable pulled while the helper idles: the tunnel's stream ends and its adapter task exits.
    async fn unplugged() -> Connection {
        let (connection, phone) = tunnel();
        drop(phone);
        while connection.adapter.bind_udp(0).await.is_ok() {}
        connection
    }

    // A phone that answers: it accepts connections to `open` ports, resets the others and acknowledges
    // every segment. It hangs up once a connection has carried `hang_up_on`, and reports whether it did.
    async fn answer(mut wire: DuplexStream, open: Vec<u16>, hang_up_on: Option<&[u8]>) -> bool {
        let host: Ipv6Addr = "fd00::1".parse().unwrap();
        let phone: Ipv6Addr = "fd00::2".parse().unwrap();
        let mut carried: HashMap<u16, Vec<u8>> = HashMap::new();
        loop {
            let mut header = [0u8; 40];
            if wire.read_exact(&mut header).await.is_err() {
                return false;
            }
            let mut packet = vec![0u8; u16::from_be_bytes([header[4], header[5]]) as usize];
            if wire.read_exact(&mut packet).await.is_err() {
                return false;
            }
            if header[6] != ProtocolNumber::Tcp as u8 {
                continue;
            }
            let segment = TcpPacket::parse(&packet).unwrap();
            let (seq, flags) = match segment.flags {
                TcpFlags { syn: true, .. } if open.contains(&segment.destination_port) => (
                    0,
                    TcpFlags {
                        syn: true,
                        ack: true,
                        ..Default::default()
                    },
                ),
                TcpFlags { syn: true, .. } => (
                    0,
                    TcpFlags {
                        rst: true,
                        ack: true,
                        ..Default::default()
                    },
                ),
                _ if segment.payload.is_empty() => continue,
                _ => (
                    1,
                    TcpFlags {
                        ack: true,
                        ..Default::default()
                    },
                ),
            };
            let ack = segment
                .sequence_number
                .wrapping_add(segment.payload.len().max(segment.flags.syn as usize) as u32);
            let reply = TcpPacket::create(
                IpAddr::V6(phone),
                IpAddr::V6(host),
                segment.destination_port,
                segment.source_port,
                seq,
                ack,
                flags,
                u16::MAX,
                &[],
                &[],
            );
            let reply = Ipv6Packet::create(phone, host, ProtocolNumber::Tcp, 64, &reply);
            if wire.write_all(&reply).await.is_err() {
                return false;
            }
            let carried = carried.entry(segment.source_port).or_default();
            carried.extend(&segment.payload);
            if hang_up_on.is_some_and(|marker| carried.windows(marker.len()).any(|w| w == marker)) {
                return true;
            }
        }
    }

    #[tokio::test]
    async fn data_socket_uses_control_peer_address_and_listener_port() {
        use tokio::net::TcpListener;
        let control_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = TcpStream::connect(control_listener.local_addr().unwrap())
            .await
            .unwrap();
        let (_phone, _) = control_listener.accept().await.unwrap();
        let data_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let control = Control {
            client: RemotePairingClient::new(RpPairingSocket::new(client), "poki-mcp"),
            peer: control_listener.local_addr().unwrap(),
        };
        let mut socket = control
            .open_data_socket(data_listener.local_addr().unwrap().port())
            .await
            .unwrap();
        let (mut data, _) = data_listener.accept().await.unwrap();
        socket.write_all(b"data").await.unwrap();
        let mut bytes = [0; 4];
        data.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes, b"data");
        assert_eq!(
            socket.peer_addr().unwrap(),
            data_listener.local_addr().unwrap()
        );
    }

    #[test]
    fn only_bonjour_hosts_opt_into_control_refresh() {
        for (host, expected) in [
            ("phone.local", true),
            ("Phone.LOCAL.", true),
            ("phone.tailnet.ts.net", false),
            ("localhost", false),
            ("127.0.0.1", false),
            ("fe80::1%en0", false),
            ("fe80::1%en0.local", false),
        ] {
            let config = Config {
                id: "fixture".into(),
                host: host.into(),
                port: 1,
                pairing_file: "missing".into(),
            };
            assert_eq!(config.uses_bonjour(), expected, "{host}");
        }
    }

    #[tokio::test]
    async fn bonjour_explicit_reconnect_refreshes_control_and_preserves_live_tunnel() {
        use tokio::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (mut phone, _) = listener.accept().await.unwrap();
        let (live, _wire) = tunnel();
        let mut session = Session {
            transport: Transport::Remote(Config {
                id: "fixture".into(),
                host: "poki-test-missing.local".into(),
                port: 1,
                pairing_file: "/not-real".into(),
            }),
            control: Some(Control {
                client: RemotePairingClient::new(RpPairingSocket::new(client), "poki-mcp"),
                peer: listener.local_addr().unwrap(),
            }),
            connection: Some(live),
            stream: Streaming::default(),
        };
        let received = tokio::spawn(async move { phone.read(&mut [0u8; 4096]).await.unwrap_or(0) });
        assert!(session.request(json!({"op":"reconnect"})).await.is_err());
        assert_eq!(
            received.await.unwrap(),
            0,
            "explicit Bonjour reconnect reused stale control"
        );
        assert!(
            session
                .connection
                .as_ref()
                .expect("working tunnel discarded")
                .adapter
                .bind_udp(0)
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn dead_bonjour_tunnel_drops_stale_control() {
        use tokio::net::TcpListener;
        // The old control socket still looks alive, while the underlying tunnel died.
        let old = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = TcpStream::connect(old.local_addr().unwrap()).await.unwrap();
        let (mut old_phone, _) = old.accept().await.unwrap();
        let stale = RemotePairingClient::new(RpPairingSocket::new(client), "poki-mcp");
        let mut session = Session {
            transport: Transport::Remote(Config {
                id: "synthetic-phone".into(),
                host: "poki-test-missing.local".into(),
                port: 1,
                pairing_file: "/not-a-real-pairing-file".into(),
            }),
            control: Some(Control {
                client: stale,
                peer: old.local_addr().unwrap(),
            }),
            connection: Some(unplugged().await),
            stream: Streaming::default(),
        };
        let received =
            tokio::spawn(async move { old_phone.read(&mut [0u8; 4096]).await.unwrap_or(0) });
        assert!(session.request(json!({"op":"ax_tree"})).await.is_err());
        assert_eq!(
            received.await.unwrap(),
            0,
            "dead Bonjour tunnel reused its stale control"
        );
    }

    #[tokio::test]
    async fn non_bonjour_recovery_keeps_using_its_existing_control() {
        use tokio::net::TcpListener;
        // A nonexistent interface makes an accidental scoped-IP redial fail
        // locally, without probing any real LAN endpoint in this regression.
        for host in [
            "127.0.0.1",
            "fd00::1",
            "fe80::1%poki-no-such-interface",
            "phone.tailnet.ts.net",
            "localhost",
        ] {
            let old = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let client = TcpStream::connect(old.local_addr().unwrap()).await.unwrap();
            let (mut phone, _) = old.accept().await.unwrap();
            let current = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut session = Session {
                transport: Transport::Remote(Config {
                    id: "synthetic-phone".into(),
                    host: host.into(),
                    port: current.local_addr().unwrap().port(),
                    pairing_file: "/not-a-real-pairing-file".into(),
                }),
                control: Some(Control {
                    client: RemotePairingClient::new(RpPairingSocket::new(client), "poki-mcp"),
                    peer: old.local_addr().unwrap(),
                }),
                connection: Some(unplugged().await),
                stream: Streaming::default(),
            };
            let received =
                tokio::spawn(async move { phone.read(&mut [0u8; 4096]).await.unwrap_or(0) });
            assert!(session.request(json!({"op":"ax_tree"})).await.is_err());
            assert!(
                received.await.unwrap() > 0,
                "fixed-IP recovery dropped its established control"
            );
        }
    }

    #[tokio::test]
    async fn unreachable_control_reports_each_address_and_its_os_error() {
        use tokio::net::TcpListener;
        // macOS gives its loopback interface the link-local fe80::1; Linux does not, and numbers
        // the refused-connection error differently.
        let mut cases = vec![("127.0.0.1", "127.0.0.1")];
        if cfg!(target_os = "macos") {
            cases.push(("fe80::1%lo0", "[fe80::1%lo0]"));
        }
        for (host, address) in cases {
            let listener = TcpListener::bind((host, 0)).await.unwrap();
            let port = listener.local_addr().unwrap().port();
            drop(listener);
            let mut session = Session {
                transport: Transport::Remote(Config {
                    id: "synthetic-phone".into(),
                    host: host.into(),
                    port,
                    pairing_file: "/not-a-real-pairing-file".into(),
                }),
                control: None,
                connection: None,
                stream: Streaming::default(),
            };
            let error = session
                .request(json!({"op":"connect"}))
                .await
                .unwrap_err()
                .to_string();
            assert!(
                error.starts_with("Remote pairing is unreachable"),
                "{error}"
            );
            assert!(
                error.contains(&format!(
                    "{address}:{port}: Connection refused (os error {})",
                    libc::ECONNREFUSED
                )),
                "{error}"
            );
        }
    }

    #[tokio::test]
    async fn failed_remote_replacement_keeps_the_working_tunnel() {
        use tokio::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let (mut live, _phone) = tunnel();
        live.rsd.uuid = "working tunnel".into();
        let mut session = Session {
            transport: Transport::Remote(Config {
                id: "synthetic-phone".into(),
                host: "localhost".into(),
                port,
                pairing_file: "/not-a-real-pairing-file".into(),
            }),
            control: None,
            connection: Some(live),
            stream: Streaming::default(),
        };
        assert!(session.request(json!({"op":"reconnect"})).await.is_err());
        let kept = session
            .connection
            .as_ref()
            .expect("working tunnel was discarded");
        assert_eq!(kept.rsd.uuid, "working tunnel");
        assert!(kept.adapter.bind_udp(0).await.is_ok());
    }

    #[tokio::test]
    async fn first_request_after_replug_rebuilds_the_tunnel_and_never_claims_delivery() {
        let mut failures = Vec::new();
        for request in [
            json!({"op":"tap","x":100,"y":200}),
            json!({"op":"launch_app","bundle_id":"local.fixture"}),
            json!({"op":"ax_tree"}),
        ] {
            let (sender, mut phones) = mpsc::unbounded_channel();
            PHONE.with(|slot| *slot.borrow_mut() = Some(sender));
            // The rebuilt tunnel carries the request's first packet; then the phone is gone again.
            let reached = tokio::spawn(async move {
                let mut reached = false;
                while let Some(mut phone) = phones.recv().await {
                    let mut byte = [0u8; 1];
                    reached |= phone.read(&mut byte).await.is_ok_and(|n| n > 0);
                }
                reached
            });
            let mut session = Session {
                transport: Transport::Local("fixture-phone".into()),
                control: None,
                connection: Some(unplugged().await),
                stream: Streaming::default(),
            };
            let reply = session.request(request.clone()).await;
            PHONE.with(|slot| slot.borrow_mut().take());
            if !reached.await.unwrap() {
                failures.push(format!(
                    "{request}: did not rebuild the tunnel; reply: {reply:?}"
                ));
            }
            let reported = match (request["op"].as_str().unwrap(), &reply) {
                ("ax_tree", Err(error)) => !error.to_string().contains("delivered"),
                ("tap", Ok(reply)) => {
                    reply["outcome"] == "not_sent" && reply["stop_reason"] == "error"
                }
                ("launch_app", Ok(reply)) => reply["outcome"] == "not_sent",
                _ => false,
            };
            if !reported {
                failures.push(format!(
                    "{request}: nothing was sent, but the reply is {reply:?}"
                ));
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[tokio::test]
    async fn a_request_refused_before_any_input_says_nothing_was_sent() {
        let mut failures = Vec::new();
        let stroke = |time_ms: Value| json!({"op":"draw_strokes","strokes":[[{"x":100,"y":100,"time_ms":0},{"x":200,"y":200,"time_ms":time_ms}]]});
        for request in [
            // Refused by validation, and refused while parsing.
            stroke(json!(0)),
            stroke(json!("12")),
            json!({"op":"tap","x":-1,"y":200}),
            json!({"op":"ax_tree","include_offscreen":"yes"}),
        ] {
            // No tunnel is open, so a refusal must come before any connection attempt.
            let mut session = Session {
                transport: Transport::Local("fixture-phone".into()),
                control: None,
                connection: None,
                stream: Streaming::default(),
            };
            let reply = session.request(request.clone()).await;
            let reported = match (request["op"].as_str().unwrap(), &reply) {
                ("ax_tree", Err(error)) => !error.to_string().contains("delivered"),
                (_, Ok(reply)) => {
                    reply["outcome"] == "not_sent"
                        && reply["sent"] == false
                        && reply["isError"] == true
                        && !reply["instruction"]
                            .as_str()
                            .unwrap_or("")
                            .contains("delivered")
                }
                _ => false,
            };
            if !reported || session.connection.is_some() {
                failures.push(format!(
                    "{request}: nothing was sent, but the reply is {reply:?}"
                ));
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[tokio::test(start_paused = true)]
    async fn a_tunnel_whose_phone_stops_answering_is_rebuilt() {
        let mut failures = Vec::new();
        for request in [json!({"op":"ax_tree"}), json!({"op":"tap","x":100,"y":200})] {
            let (sender, mut phones) = mpsc::unbounded_channel();
            PHONE.with(|slot| *slot.borrow_mut() = Some(sender));
            // The adapter task keeps running, but the phone never answers: Wi-Fi dropped without a reset.
            let (mut silent, _phone) = tunnel();
            silent.rsd.uuid = "silent tunnel".into();
            let mut session = Session {
                transport: Transport::Local("fixture-phone".into()),
                control: None,
                connection: Some(silent),
                stream: Streaming::default(),
            };
            let reply = session.request(request.clone()).await;
            PHONE.with(|slot| slot.borrow_mut().take());
            if phones.recv().await.is_none() {
                failures.push(format!(
                    "{request}: a silent tunnel was kept; reply: {reply:?}"
                ));
            }
            if session.connection.as_ref().map(|c| c.rsd.uuid.as_str()) == Some("silent tunnel") {
                failures.push(format!("{request}: the silent tunnel is still in use"));
            }
            let reported = match (request["op"].as_str().unwrap(), &reply) {
                ("ax_tree", Err(error)) => !error.to_string().contains("delivered"),
                ("tap", Ok(reply)) => {
                    reply["outcome"] == "not_sent" && reply["stop_reason"] == "error"
                }
                _ => false,
            };
            if !reported {
                failures.push(format!(
                    "{request}: nothing was sent, but the reply is {reply:?}"
                ));
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    fn session_with(connection: Connection) -> Session {
        Session {
            transport: Transport::Local("fixture-phone".into()),
            control: None,
            connection: Some(connection),
            stream: Streaming::default(),
        }
    }

    #[tokio::test]
    async fn ddi_status_reports_displayservice_without_opening_a_phone_service() {
        let (connection, _phone) = tunnel();
        let mut session = session_with(connection);
        for request in [
            json!({"op":"ddi_status"}),
            json!({"op":"ddi_status","services_only":true}),
        ] {
            let reply = session.request(request).await.unwrap();
            assert_eq!(reply["display_service"], true, "{reply}");
            assert_eq!(reply["cryptexd"], false, "{reply}");
            assert_eq!(reply["ddi"], Value::Null, "{reply}");
        }
        // With cryptexd listed, services_only still answers from the service list: this fake phone
        // never answers a cryptexd request, so asking it would hang.
        let cryptexd = session.connection.as_ref().unwrap().rsd.services
            [crate::Hid::rsd_service_name().as_ref()]
        .clone();
        session
            .connection
            .as_mut()
            .unwrap()
            .rsd
            .services
            .insert("com.apple.security.cryptexd.remote".into(), cryptexd);
        let reply = tokio::time::timeout(
            Duration::from_secs(5),
            session.request(json!({"op":"ddi_status","services_only":true})),
        )
        .await
        .expect("services_only must not ask the phone")
        .unwrap();
        assert_eq!(reply["cryptexd"], true, "{reply}");
        assert_eq!(reply["ddi_error"], Value::Null, "{reply}");
    }

    #[tokio::test(start_paused = true)]
    async fn ddi_status_leaves_an_open_input_session_alone() {
        let (display, _display_phone) = tokio::io::duplex(1 << 16);
        let now = tokio::time::Instant::now();
        let media = InputMedia {
            client: DisplayServiceClient::from_stream(Box::new(display))
                .await
                .unwrap(),
            receivers: tokio::task::JoinSet::new(),
            ready_at: now,
            last_input: now,
            last_activity: now,
        };
        let (mut connection, _phone) = tunnel();
        connection.media = Some(media);
        let mut session = session_with(connection);
        let reply = session
            .request(json!({"op":"ddi_status","services_only":true}))
            .await
            .unwrap();
        assert_eq!(reply["display_service"], true, "{reply}");
        assert!(
            session.connection.as_ref().unwrap().media.is_some(),
            "a status read tore down the input session"
        );
    }

    #[tokio::test]
    async fn install_ddi_names_the_stage_that_failed_before_touching_the_phone() {
        let (mut connection, _phone) = tunnel();
        connection
            .rsd
            .services
            .remove(DisplayServiceClient::<Box<dyn ReadWrite>>::rsd_service_name().as_ref());
        let mut session = session_with(connection);
        assert!(
            session.request(json!({"op":"install_ddi"})).await.is_err(),
            "install_ddi without restore_dir must be refused"
        );
        let reply = session
            .request(json!({"op":"install_ddi","restore_dir":"/nonexistent"}))
            .await
            .unwrap();
        assert_eq!(reply["installed"], false, "{reply}");
        assert_eq!(reply["stage"], "unavailable", "{reply}");
        assert_eq!(reply["display_service"], false, "{reply}");

        let cryptexd = session.connection.as_ref().unwrap().rsd.services
            [crate::Hid::rsd_service_name().as_ref()]
        .clone();
        session
            .connection
            .as_mut()
            .unwrap()
            .rsd
            .services
            .insert("com.apple.security.cryptexd.remote".into(), cryptexd);
        let missing = std::env::temp_dir().join(format!("poki-no-ddi-{}", uuid::Uuid::new_v4()));
        let reply = session
            .request(json!({"op":"install_ddi","restore_dir":missing.to_str().unwrap()}))
            .await
            .unwrap();
        assert_eq!(reply["installed"], false, "{reply}");
        assert_eq!(reply["stage"], "image", "{reply}");
    }

    #[tokio::test]
    async fn a_service_refused_on_a_live_tunnel_keeps_that_tunnel() {
        let (sender, mut phones) = mpsc::unbounded_channel();
        PHONE.with(|slot| *slot.borrow_mut() = Some(sender));
        // The adapter is alive, but the phone offers no display service, so opening it fails before any input.
        let (mut live, _phone) = tunnel();
        live.rsd.services.clear();
        live.rsd.uuid = "live tunnel".into();
        let mut session = Session {
            transport: Transport::Local("fixture-phone".into()),
            control: None,
            connection: Some(live),
            stream: Streaming::default(),
        };
        let reply = session.request(json!({"op":"tap","x":100,"y":200})).await;
        PHONE.with(|slot| slot.borrow_mut().take());
        let reply = reply.expect("a refused service is a reply, not a transport error");
        assert_eq!(reply["outcome"], "not_sent", "{reply}");
        assert_eq!(reply["stop_reason"], "error", "{reply}");
        assert_eq!(reply["reason"], "display_service_missing", "{reply}");
        assert!(phones.recv().await.is_none(), "a live tunnel was rebuilt");
        let kept = session
            .connection
            .as_ref()
            .expect("the live tunnel was dropped");
        assert_eq!(kept.rsd.uuid, "live tunnel");
        assert!(kept.adapter.bind_udp(0).await.is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn a_tap_cut_off_after_it_reached_the_phone_is_not_repeated() {
        let (sender, mut phones) = mpsc::unbounded_channel();
        PHONE.with(|slot| *slot.borrow_mut() = Some(sender));
        // An earlier input left the media session open, so the tap goes straight to the touch service.
        let (display, _display_phone) = tokio::io::duplex(1 << 16);
        let now = tokio::time::Instant::now();
        let media = InputMedia {
            client: DisplayServiceClient::from_stream(Box::new(display))
                .await
                .unwrap(),
            receivers: tokio::task::JoinSet::new(),
            ready_at: now,
            last_input: now,
            last_activity: now,
            display_id: 1,
            hub: Default::default(),
            alive: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        };
        let (mut connection, phone) = tunnel();
        // This phone advertises device information and refuses the display query, so the tap also
        // shows that such a phone keeps the main touchscreen.
        connection.media = Some(media);
        let touch = connection.rsd.services[crate::Hid::rsd_service_name().as_ref()].port;
        // The touch report reaches the phone; the tunnel goes down before the release.
        let phone = tokio::spawn(async move { answer(phone, vec![touch], Some(b"send\0")).await });
        let mut session = Session {
            transport: Transport::Local("fixture-phone".into()),
            control: None,
            connection: Some(connection),
            stream: Streaming::default(),
        };
        let reply = session.request(json!({"op":"tap","x":100,"y":200})).await;
        PHONE.with(|slot| slot.borrow_mut().take());
        assert!(
            phone.await.unwrap(),
            "the touch never reached the phone; reply: {reply:?}"
        );
        let error = reply.expect_err("a tap that may have landed was reported as a reply");
        assert!(
            error.to_string().contains("Input may have been delivered"),
            "{error}"
        );
        assert!(
            phones.recv().await.is_none(),
            "the tap was repeated on a new tunnel"
        );
        assert!(session.connection.is_none(), "the dead tunnel was kept");
    }

    #[tokio::test(start_paused = true)]
    async fn a_socket_error_on_a_tunnel_whose_phone_still_answers_keeps_that_tunnel() {
        let (sender, mut phones) = mpsc::unbounded_channel();
        PHONE.with(|slot| *slot.borrow_mut() = Some(sender));
        // The phone resets the display service connection but still accepts its RSD port.
        let (mut live, phone) = tunnel();
        live.rsd.uuid = "live tunnel".into();
        tokio::spawn(answer(phone, vec![live.rsd_port], None));
        let mut session = Session {
            transport: Transport::Local("fixture-phone".into()),
            control: None,
            connection: Some(live),
            stream: Streaming::default(),
        };
        let reply = session.request(json!({"op":"tap","x":100,"y":200})).await;
        PHONE.with(|slot| slot.borrow_mut().take());
        let reply = reply.expect("a reset service is a reply, not a transport error");
        assert_eq!(reply["outcome"], "not_sent", "{reply}");
        assert_eq!(reply["stop_reason"], "error", "{reply}");
        assert!(
            phones.recv().await.is_none(),
            "a tunnel whose phone answers was rebuilt"
        );
        let kept = session
            .connection
            .as_ref()
            .expect("the live tunnel was dropped");
        assert_eq!(kept.rsd.uuid, "live tunnel");
    }

    #[tokio::test(start_paused = true)]
    async fn idle_session_releases_input_media_and_keeps_the_tunnel() {
        use tokio::io::AsyncBufReadExt;
        let (sender, mut phones) = mpsc::unbounded_channel();
        PHONE.with(|slot| *slot.borrow_mut() = Some(sender));
        let make_media = |now: tokio::time::Instant| async move {
            let (display, display_phone) = tokio::io::duplex(1 << 16);
            let (media_open, media_closed) = mpsc::unbounded_channel::<()>();
            let mut receivers = tokio::task::JoinSet::new();
            receivers.spawn(async move {
                let _open = media_open;
                std::future::pending::<()>().await;
            });
            let media = InputMedia {
                client: DisplayServiceClient::from_stream(Box::new(display))
                    .await
                    .unwrap(),
                receivers,
                ready_at: now,
                last_input: now,
                last_activity: now,
                display_id: 1,
                hub: Default::default(),
                alive: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            };
            drop(display_phone);
            (media, media_closed)
        };

        // 1. In-flight read-only operation crossing INPUT_MEDIA_MAX_READ_HOLD releases media
        // while keeping the live tunnel intact.
        let start = tokio::time::Instant::now();
        let (media, mut slow_read_closed) = make_media(start).await;
        let (mut connection, phone) = tunnel();
        connection.rsd.uuid = "live tunnel".into();
        connection.media = Some(media);
        let rsd_port = connection.rsd_port;
        let ax_port =
            connection.rsd.services["com.apple.accessibility.axAuditDaemon.remoteAXService"].port;
        tokio::spawn(answer(phone, vec![rsd_port, ax_port], None));
        let mut session = Session {
            transport: Transport::Local("fixture-phone".into()),
            control: None,
            connection: Some(connection),
            stream: Streaming::default(),
        };
        tokio::time::advance(INPUT_MEDIA_MAX_READ_HOLD - Duration::from_secs(1)).await;
        session
            .connection
            .as_mut()
            .unwrap()
            .media
            .as_mut()
            .unwrap()
            .last_activity = tokio::time::Instant::now();
        assert_eq!(
            session.input_media_deadline(),
            Some(start + INPUT_MEDIA_MAX_READ_HOLD)
        );
        let closed_at = tokio::spawn(async move {
            assert!(slow_read_closed.recv().await.is_none());
            start.elapsed()
        });
        assert!(session.request(json!({"op":"ax_tree"})).await.is_err());
        assert_eq!(closed_at.await.unwrap(), INPUT_MEDIA_MAX_READ_HOLD);
        assert!(start.elapsed() > INPUT_MEDIA_MAX_READ_HOLD);
        assert!(session.connection.as_ref().unwrap().media.is_none());
        assert!(
            session
                .connection
                .as_ref()
                .unwrap()
                .adapter
                .bind_udp(0)
                .await
                .is_ok()
        );

        // 2. Refused requests and half-open sockets just before the idle deadline cannot delay release.
        let reset_now = tokio::time::Instant::now();
        let (media, _media_closed) = make_media(reset_now).await;
        session.connection.as_mut().unwrap().media = Some(media);
        let refused = session
            .request(json!({"op":"tap","x":-1,"y":200}))
            .await
            .unwrap();
        assert_eq!(refused["outcome"], "not_sent");
        assert_eq!(
            session.input_media_deadline(),
            Some(reset_now + INPUT_MEDIA_IDLE_TIMEOUT)
        );
        // Reconnect releases open input media immediately while preserving the working tunnel if replacement fails.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dead_port = listener.local_addr().unwrap().port();
        drop(listener);
        let (mut remote_live, _remote_phone) = tunnel();
        let (remote_media, mut remote_media_closed) = make_media(reset_now).await;
        remote_live.media = Some(remote_media);
        let mut remote_session = Session {
            transport: Transport::Remote(Config {
                id: "synthetic-phone".into(),
                host: "127.0.0.1".into(),
                port: dead_port,
                pairing_file: "/not-a-real-pairing-file".into(),
            }),
            control: None,
            connection: Some(remote_live),
            stream: Streaming::default(),
        };
        assert!(
            remote_session
                .request(json!({"op":"reconnect"}))
                .await
                .is_err()
        );
        assert!(remote_media_closed.recv().await.is_none());
        assert!(remote_session.connection.as_ref().unwrap().media.is_none());
        assert!(
            remote_session
                .connection
                .as_ref()
                .unwrap()
                .adapter
                .bind_udp(0)
                .await
                .is_ok()
        );

        let reset_now = tokio::time::Instant::now();
        let (media, mut media_closed) = make_media(reset_now).await;
        session.connection.as_mut().unwrap().media = Some(media);

        let dir = std::env::temp_dir().join(format!(
            "poki-idle-media-{}-{}",
            std::process::id(),
            reset_now.elapsed().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let socket_path = dir.join("session.sock");
        let socket_str = socket_path.to_str().unwrap().to_owned();
        let client_socket = socket_path.clone();
        let client = async move {
            while !client_socket.exists() {
                tokio::task::yield_now().await;
            }
            tokio::time::sleep(INPUT_MEDIA_IDLE_TIMEOUT - Duration::from_millis(100)).await;
            let stalled = tokio::net::UnixStream::connect(&client_socket)
                .await
                .unwrap();
            let mut stalled_reader = BufReader::new(stalled);
            let mut greeting = String::new();
            stalled_reader.read_line(&mut greeting).await.unwrap();

            assert!(
                media_closed.recv().await.is_none(),
                "idle input media session was not closed during stalled client read"
            );
            assert!(
                reset_now.elapsed() >= INPUT_MEDIA_IDLE_TIMEOUT
                    && reset_now.elapsed() < INPUT_MEDIA_IDLE_TIMEOUT + Duration::from_secs(1),
                "stalled client connection delayed idle media release: {:?}",
                reset_now.elapsed()
            );
            drop(stalled_reader);

            let send = |request: &str| {
                let socket_path = client_socket.clone();
                let request = request.to_owned();
                async move {
                    let stream = tokio::net::UnixStream::connect(&socket_path).await.unwrap();
                    let mut reader = BufReader::new(stream);
                    let mut greeting = String::new();
                    reader.read_line(&mut greeting).await.unwrap();
                    reader
                        .get_mut()
                        .write_all(request.as_bytes())
                        .await
                        .unwrap();
                    let mut reply = String::new();
                    reader.read_line(&mut reply).await.unwrap();
                    serde_json::from_str::<Value>(&reply).unwrap()
                }
            };
            let connected = send("{\"op\":\"connect\"}\n").await;
            assert_eq!(connected["connected"], true, "{connected}");
            let disconnected = send("{\"op\":\"disconnect\"}\n").await;
            assert_eq!(disconnected["disconnected"], true, "{disconnected}");
            Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
        };
        let (result, ()) = tokio::try_join!(
            Box::pin(serve_session(session, &socket_str)),
            Box::pin(client)
        )
        .unwrap();
        assert_eq!(result["closed"], true);
        assert!(
            phones.try_recv().is_err(),
            "releasing idle input media dropped the live tunnel"
        );
        PHONE.with(|slot| slot.borrow_mut().take());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn client_disconnect_during_in_flight_input_releases_media_and_never_replays() {
        std::thread::Builder::new()
            .stack_size(8 * 1024 * 1024)
            .spawn(|| {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .start_paused(true)
                    .build()
                    .unwrap()
                    .block_on(
                        client_disconnect_during_in_flight_input_releases_media_and_never_replays_inner(),
                    );
            })
            .unwrap()
            .join()
            .unwrap();
    }

    async fn client_disconnect_during_in_flight_input_releases_media_and_never_replays_inner() {
        use tokio::io::AsyncBufReadExt;
        let (sender, mut phones) = mpsc::unbounded_channel();
        PHONE.with(|slot| *slot.borrow_mut() = Some(sender));

        let now = tokio::time::Instant::now();
        let (display, display_phone) = tokio::io::duplex(1 << 16);
        let (media_open, mut media_closed) = mpsc::unbounded_channel::<()>();
        let mut receivers = tokio::task::JoinSet::new();
        receivers.spawn(async move {
            let _open = media_open;
            std::future::pending::<()>().await;
        });
        let media = InputMedia {
            client: DisplayServiceClient::from_stream(Box::new(display))
                .await
                .unwrap(),
            receivers,
            ready_at: now,
            last_input: now,
            last_activity: now,
            display_id: 1,
            hub: Default::default(),
            alive: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        };
        drop(display_phone);
        let (mut connection, mut wire) = tunnel();
        connection.media = Some(media);
        let touch_port = connection.rsd.services[crate::Hid::rsd_service_name().as_ref()].port;

        let (first_send_tx, first_send_rx) = tokio::sync::oneshot::channel::<()>();
        let phone_task = tokio::spawn(async move {
            let host: Ipv6Addr = "fd00::1".parse().unwrap();
            let phone: Ipv6Addr = "fd00::2".parse().unwrap();
            let mut carried: HashMap<u16, Vec<u8>> = HashMap::new();
            let mut touch_syns = 0usize;
            let mut notified = Some(first_send_tx);
            loop {
                let mut header = [0u8; 40];
                if wire.read_exact(&mut header).await.is_err() {
                    break;
                }
                let mut packet = vec![0u8; u16::from_be_bytes([header[4], header[5]]) as usize];
                if wire.read_exact(&mut packet).await.is_err() {
                    break;
                }
                if header[6] != ProtocolNumber::Tcp as u8 {
                    continue;
                }
                let segment = TcpPacket::parse(&packet).unwrap();
                let (seq, flags) = match segment.flags {
                    TcpFlags { syn: true, .. } if segment.destination_port == touch_port => {
                        touch_syns += 1;
                        (
                            0,
                            TcpFlags {
                                syn: true,
                                ack: true,
                                ..Default::default()
                            },
                        )
                    }
                    TcpFlags { syn: true, .. } => (
                        0,
                        TcpFlags {
                            rst: true,
                            ack: true,
                            ..Default::default()
                        },
                    ),
                    _ if segment.payload.is_empty() => continue,
                    _ => (
                        1,
                        TcpFlags {
                            ack: true,
                            ..Default::default()
                        },
                    ),
                };
                let ack = segment
                    .sequence_number
                    .wrapping_add(segment.payload.len().max(segment.flags.syn as usize) as u32);
                let reply = TcpPacket::create(
                    IpAddr::V6(phone),
                    IpAddr::V6(host),
                    segment.destination_port,
                    segment.source_port,
                    seq,
                    ack,
                    flags,
                    u16::MAX,
                    &[],
                    &[],
                );
                let reply = Ipv6Packet::create(phone, host, ProtocolNumber::Tcp, 64, &reply);
                if wire.write_all(&reply).await.is_err() {
                    break;
                }
                let stream_bytes = carried.entry(segment.source_port).or_default();
                stream_bytes.extend(&segment.payload);
                if notified.is_some()
                    && stream_bytes
                        .windows(b"send\0".len())
                        .any(|w| w == b"send\0")
                {
                    let _ = notified.take().unwrap().send(());
                }
            }
            let total_send_calls: usize = carried
                .values()
                .map(|bytes| {
                    bytes
                        .windows(b"send\0".len())
                        .filter(|w| *w == b"send\0")
                        .count()
                })
                .sum();
            (touch_syns, total_send_calls)
        });

        let session = Session {
            transport: Transport::Local("fixture-phone".into()),
            control: None,
            connection: Some(connection),
            stream: Streaming::default(),
        };
        let dir = std::env::temp_dir().join(format!(
            "poki-interrupted-input-{}-{}",
            std::process::id(),
            now.elapsed().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let socket_path = dir.join("session.sock");
        let socket_str = socket_path.to_str().unwrap().to_owned();
        let client_socket = socket_path.clone();

        let client = async move {
            while !client_socket.exists() {
                tokio::task::yield_now().await;
            }
            let stream = tokio::net::UnixStream::connect(&client_socket)
                .await
                .unwrap();
            let mut reader = BufReader::new(stream);
            let mut greeting = String::new();
            reader.read_line(&mut greeting).await.unwrap();
            reader
                .get_mut()
                .write_all(b"{\"op\":\"tap\",\"x\":100,\"y\":200,\"duration_ms\":1000}\n")
                .await
                .unwrap();
            // Wait until the contact report reached the phone, then drop the client socket mid-tap.
            first_send_rx.await.unwrap();
            drop(reader);

            assert!(
                media_closed.recv().await.is_none(),
                "interrupted input did not discard the media session"
            );
            assert!(
                now.elapsed() < Duration::from_millis(1000),
                "interrupted input was not cancelled immediately before hold completion: {:?}",
                now.elapsed()
            );

            let stream = tokio::net::UnixStream::connect(&client_socket)
                .await
                .unwrap();
            let mut reader = BufReader::new(stream);
            let mut greeting = String::new();
            reader.read_line(&mut greeting).await.unwrap();
            reader
                .get_mut()
                .write_all(b"{\"op\":\"connect\"}\n")
                .await
                .unwrap();
            let mut reply = String::new();
            reader.read_line(&mut reply).await.unwrap();
            let connected: Value = serde_json::from_str(&reply).unwrap();
            assert_eq!(connected["connected"], true);

            let stream = tokio::net::UnixStream::connect(&client_socket)
                .await
                .unwrap();
            let mut reader = BufReader::new(stream);
            let mut greeting = String::new();
            reader.read_line(&mut greeting).await.unwrap();
            reader
                .get_mut()
                .write_all(b"{\"op\":\"disconnect\"}\n")
                .await
                .unwrap();
            let mut reply = String::new();
            reader.read_line(&mut reply).await.unwrap();
            let disconnected: Value = serde_json::from_str(&reply).unwrap();
            assert_eq!(disconnected["disconnected"], true);
            Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
        };

        let (result, ()) = tokio::try_join!(
            Box::pin(serve_session(session, &socket_str)),
            Box::pin(client)
        )
        .unwrap();
        assert_eq!(result["closed"], true);
        let (touch_syns, total_send_calls) = phone_task.await.unwrap();
        assert_eq!(
            touch_syns, 1,
            "interrupted tap opened Touch service {touch_syns} times (replayed)"
        );
        assert_eq!(
            total_send_calls, 1,
            "interrupted tap was not aborted mid-hold (expected 1 HID send, got {total_send_calls})"
        );
        assert!(
            phones.try_recv().is_err(),
            "interrupted tap rebuilt the tunnel or replayed on a second connection"
        );
        PHONE.with(|slot| slot.borrow_mut().take());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Input media whose video arrives on the returned sender, as the phone's would. The
    /// receiver ends (recv returns None) when the media session is closed.
    async fn watched_media(
        hub: &Arc<VideoHub>,
        now: tokio::time::Instant,
    ) -> (
        InputMedia,
        mpsc::UnboundedReceiver<()>,
        mpsc::UnboundedSender<crate::video::Datagram>,
        mpsc::UnboundedReceiver<(u16, Vec<u8>)>,
    ) {
        let (display, display_phone) = tokio::io::duplex(1 << 16);
        let (media_open, media_closed) = mpsc::unbounded_channel::<()>();
        let (incoming_tx, incoming) = mpsc::unbounded_channel();
        let (sent, sent_rx) = mpsc::unbounded_channel();
        let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let pump = crate::video::pump(
            crate::video::Source::Test { incoming, sent },
            hub.clone(),
            crate::video::Feedback {
                our_ssrc: 0x1234,
                sender_port: 50001,
            },
            alive.clone(),
        );
        let mut receivers = tokio::task::JoinSet::new();
        receivers.spawn(async move {
            let _open = media_open;
            pump.await;
            std::future::pending::<()>().await;
        });
        let media = InputMedia {
            client: DisplayServiceClient::from_stream(Box::new(display))
                .await
                .unwrap(),
            receivers,
            ready_at: now,
            last_input: now,
            last_activity: now,
            display_id: 1,
            hub: hub.clone(),
            alive,
        };
        drop(display_phone);
        (media, media_closed, incoming_tx, sent_rx)
    }

    fn datagrams(units: &[Vec<Vec<u8>>]) -> Vec<crate::video::Datagram> {
        units
            .iter()
            .flatten()
            .map(|data| crate::video::Datagram {
                source_port: 50001,
                data: data.clone(),
            })
            .collect()
    }

    // Reads, a failed read, an explicit release and a long idle keep a watched screen's media
    // session; the last viewer leaving releases it INPUT_MEDIA_IDLE_TIMEOUT later.
    #[tokio::test(start_paused = true)]
    async fn a_watched_screen_keeps_its_media_until_a_second_after_the_last_viewer_leaves() {
        let (sender, _phones) = mpsc::unbounded_channel();
        PHONE.with(|slot| *slot.borrow_mut() = Some(sender));
        let hub: Arc<VideoHub> = Default::default();
        let start = tokio::time::Instant::now();
        let (media, mut media_closed, _video, _rtcp) = watched_media(&hub, start).await;
        let (mut connection, phone) = tunnel();
        connection.media = Some(media);
        let rsd_port = connection.rsd_port;
        let ax_port =
            connection.rsd.services["com.apple.accessibility.axAuditDaemon.remoteAXService"].port;
        tokio::spawn(answer(phone, vec![rsd_port, ax_port], None));
        let mut session = Session {
            transport: Transport::Local("fixture-phone".into()),
            control: None,
            connection: Some(connection),
            stream: Streaming {
                hub: hub.clone(),
                ..Default::default()
            },
        };
        let viewer = hub.subscribe();
        tokio::time::advance(INPUT_MEDIA_MAX_READ_HOLD * 2).await;
        assert!(
            Box::pin(session.request(json!({"op":"ax_tree","wait_ms":200})))
                .await
                .is_err()
        );
        Box::pin(session.request(json!({"op":"release_input"}))).await.unwrap();
        Box::pin(with_media_deadline(&mut session, tokio::time::sleep(Duration::from_secs(30)))).await;
        assert!(
            session.connection.as_ref().unwrap().media.is_some(),
            "a watched screen's media session was released"
        );
        assert!(media_closed.try_recv().is_err());
        drop(viewer);
        let left = tokio::time::Instant::now();
        let ((), closed_after) = tokio::join!(
            Box::pin(with_media_deadline(&mut session, tokio::time::sleep(Duration::from_secs(3)))),
            async {
                assert!(media_closed.recv().await.is_none());
                left.elapsed()
            }
        );
        assert!(
            closed_after >= INPUT_MEDIA_IDLE_TIMEOUT
                && closed_after < INPUT_MEDIA_IDLE_TIMEOUT + Duration::from_millis(600),
            "released {closed_after:?} after the last viewer left"
        );
        assert!(session.connection.as_ref().unwrap().media.is_none());
        PHONE.with(|slot| slot.borrow_mut().take());
    }

    // While the screen is watched, a tap long after the last input goes straight to the touch
    // service on the open session: no new media session, so no warmup.
    #[tokio::test(start_paused = true)]
    async fn a_tap_while_streaming_reuses_the_open_media_session() {
        let (sender, mut phones) = mpsc::unbounded_channel();
        PHONE.with(|slot| *slot.borrow_mut() = Some(sender));
        let hub: Arc<VideoHub> = Default::default();
        let start = tokio::time::Instant::now();
        let (media, _closed, _video, _rtcp) = watched_media(&hub, start).await;
        let (mut connection, phone) = tunnel();
        connection.media = Some(media);
        let touch = connection.rsd.services[crate::Hid::rsd_service_name().as_ref()].port;
        let phone = tokio::spawn(async move { answer(phone, vec![touch], Some(b"send\0")).await });
        let mut session = Session {
            transport: Transport::Local("fixture-phone".into()),
            control: None,
            connection: Some(connection),
            stream: Streaming {
                hub: hub.clone(),
                ..Default::default()
            },
        };
        let _viewer = hub.subscribe();
        // Boxed, like the helper's own request path: inline these futures overflow a debug test thread.
        Box::pin(with_media_deadline(&mut session, tokio::time::sleep(Duration::from_secs(10)))).await;
        let before = tokio::time::Instant::now();
        let reply = Box::pin(session.request(json!({"op":"tap","x":100,"y":200}))).await;
        PHONE.with(|slot| slot.borrow_mut().take());
        assert!(
            phone.await.unwrap(),
            "the tap did not reach the phone over the open session; reply: {reply:?}"
        );
        assert!(
            before.elapsed() < Duration::from_millis(500),
            "the tap waited {:?}",
            before.elapsed()
        );
        assert!(phones.try_recv().is_err(), "the tap built a new tunnel");
    }

    // media_subscribe over the helper's socket: the reply names the size of the latest key
    // frame, the frames start at that key frame, the helper keeps serving other requests while
    // the subscriber streams, and media_keyframe sends PLI and FIR from the offer's SSRC.
    #[tokio::test]
    async fn a_subscriber_receives_frames_from_a_key_frame_while_requests_go_on() {
        use crate::video::tests::{packetize, sample};
        let (sender, _phones) = mpsc::unbounded_channel();
        PHONE.with(|slot| *slot.borrow_mut() = Some(sender));
        let hub: Arc<VideoHub> = Default::default();
        let (media, _closed, video, mut rtcp) =
            watched_media(&hub, tokio::time::Instant::now()).await;
        let units = packetize(&sample(), 0xabcd, 10);
        // The phone's sender report shows where RTCP goes. The viewer joins at frame 2: the
        // cached chain begins at frame 0.
        let mut report = vec![0x80, 200, 0, 6];
        report.extend_from_slice(&0xabcdu32.to_be_bytes());
        report.extend_from_slice(&[0; 20]);
        video
            .send(crate::video::Datagram {
                source_port: 50007,
                data: report,
            })
            .unwrap();
        for datagram in datagrams(&units[..3]) {
            video.send(datagram).unwrap();
        }
        while hub.size().is_none() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let (connection, _phone) = tunnel();
        let mut connection = connection;
        connection.media = Some(media);
        let session = Session {
            transport: Transport::Local("fixture-phone".into()),
            control: None,
            connection: Some(connection),
            stream: Streaming {
                hub: hub.clone(),
                ..Default::default()
            },
        };
        let dir = std::env::temp_dir().join(format!(
            "poki-subscribe-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let socket_path = dir.join("session.sock");
        let socket_str = socket_path.to_str().unwrap().to_owned();
        let client = async {
        while !socket_path.exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let open = |request: &'static str| {
            let socket_path = socket_path.clone();
            async move {
                let stream = tokio::net::UnixStream::connect(&socket_path).await.unwrap();
                let mut reader = BufReader::new(stream);
                let mut greeting = String::new();
                reader.read_line(&mut greeting).await.unwrap();
                reader
                    .get_mut()
                    .write_all(format!("{request}\n").as_bytes())
                    .await
                    .unwrap();
                let mut reply = String::new();
                reader.read_line(&mut reply).await.unwrap();
                (reader, serde_json::from_str::<Value>(&reply).unwrap())
            }
        };
        let (mut subscriber, reply) = open(r#"{"op":"media_subscribe"}"#).await;
        assert_eq!(reply["subscribed"], true, "{reply}");
        assert_eq!((reply["width"].as_u64(), reply["height"].as_u64()), (Some(180), Some(390)));
        for datagram in datagrams(&units[3..6]) {
            video.send(datagram).unwrap();
        }
        let mut frames = Vec::new();
        while frames.len() < 6 {
            let mut length = [0u8; 4];
            subscriber.read_exact(&mut length).await.unwrap();
            let mut frame = vec![0u8; u32::from_be_bytes(length) as usize];
            subscriber.read_exact(&mut frame).await.unwrap();
            frames.push(frame);
        }
        let flags: Vec<u8> = frames.iter().map(|f| f[0]).collect();
        let key = crate::video::FLAG_KEY | crate::video::FLAG_CONFIG;
        assert_eq!(flags[0], key | crate::video::FLAG_RESET);
        assert_eq!(&flags[1..], &[0, 0, 0, key, 0]);
        let seqs: Vec<u64> = frames
            .iter()
            .map(|f| u64::from_be_bytes(f[1..9].try_into().unwrap()))
            .collect();
        assert!(seqs.windows(2).all(|w| w[1] == w[0] + 1), "{seqs:?}");
        // Other requests are served while the subscriber streams.
        let (_, keyframe) = open(r#"{"op":"media_keyframe"}"#).await;
        assert_eq!(keyframe["requested"], true, "{keyframe}");
        assert_eq!(keyframe["subscribers"], 1, "{keyframe}");
        // Receiver reports go out every second while watched; the keyframe request is the one
        // with payload-specific feedback (PT 206).
        let (port, request) = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let (port, packet) = rtcp.recv().await.unwrap();
                let mut offset = 0;
                while offset + 4 <= packet.len() {
                    if packet[offset + 1] == 206 {
                        return (port, packet);
                    }
                    offset += (u16::from_be_bytes([packet[offset + 2], packet[offset + 3]]) as usize + 1) * 4;
                }
            }
        })
        .await
        .expect("no keyframe request was sent");
        assert_eq!(port, 50007, "RTCP went to {port}, not the phone's RTCP port");
        // RR, SDES, PLI and FIR, from the SSRC this host declared.
        assert_eq!(&request[4..8], &0x1234u32.to_be_bytes());
        let mut offset = 0;
        let mut feedback = Vec::new();
        while offset + 4 <= request.len() {
            let (format, kind) = (request[offset] & 0x1f, request[offset + 1]);
            if kind == 206 {
                feedback.push(format);
                assert_eq!(&request[offset + 4..offset + 8], &0x1234u32.to_be_bytes());
            }
            offset += (u16::from_be_bytes([request[offset + 2], request[offset + 3]]) as usize + 1) * 4;
        }
        assert_eq!(feedback, [1, 4]);
        drop(subscriber);
        while hub.subscribers() != 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let (_, closed) = open(r#"{"op":"disconnect"}"#).await;
        assert_eq!(closed["disconnected"], true);
        };
        let (served, ()) = tokio::join!(Box::pin(serve_session(session, &socket_str)), client);
        assert_eq!(served.unwrap()["closed"], true);
        PHONE.with(|slot| slot.borrow_mut().take());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // A tunnel that died while the screen was watched is replaced on the next attempt, instead of
    // retrying the media session on the dead adapter for ever.
    #[tokio::test(start_paused = true)]
    async fn a_watched_screen_rebuilds_a_dead_tunnel() {
        let (sender, mut phones) = mpsc::unbounded_channel();
        PHONE.with(|slot| *slot.borrow_mut() = Some(sender));
        let hub: Arc<VideoHub> = Default::default();
        let mut session = Session {
            transport: Transport::Local("fixture-phone".into()),
            control: None,
            connection: Some(unplugged().await),
            stream: Streaming {
                hub: hub.clone(),
                ..Default::default()
            },
        };
        let _viewer = hub.subscribe();
        assert!(Box::pin(session.ensure_media()).await.is_err());
        assert!(session.connection.is_none(), "the dead tunnel was kept");
        // The next attempt asks for a new tunnel (the fixture phone answers nothing, so the media
        // session itself still fails).
        let _ = Box::pin(session.ensure_media()).await;
        assert!(phones.try_recv().is_ok(), "no new tunnel was built");
        PHONE.with(|slot| slot.borrow_mut().take());
    }

    #[test]
    fn sending_host_is_read_from_pairing_metadata_when_present() {
        let pairing = RpPairingFile::generate("linux-host");
        let mut dictionary: plist::Dictionary = plist::from_bytes(&pairing.to_bytes()).unwrap();
        dictionary.insert("sending_host".into(), "linux-host".into());
        let mut bytes = Vec::new();
        plist::to_writer_xml(&mut bytes, &dictionary).unwrap();
        assert_eq!(pairing_sending_host(&bytes).as_deref(), Some("linux-host"));
        assert_eq!(pairing_sending_host(&pairing.to_bytes()), None);
    }
}
