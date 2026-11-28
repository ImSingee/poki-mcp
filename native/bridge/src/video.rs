//! The phone's screen as live video.
//!
//! The displayservice session that holds the input gate open (`InputMedia` in main.rs) also sends
//! the screen as HEVC over RTP. This module turns those packets into whole access units and hands
//! them to subscribers (`media_subscribe` in remote.rs):
//!
//! - `Assembler` reassembles access units with idevice's `HevcDepacketizer`. A lost packet breaks
//!   the reference chain, so after one nothing is sent until the next key frame.
//! - `VideoHub` belongs to the helper's session, not to one media session, so subscribers survive a
//!   media restart. It keeps the latest key frame and the frames after it, so a new subscriber
//!   starts on a decodable picture even when the screen is still and the phone sends nothing.
//! - A subscriber that falls behind skips to the next key frame. No subscriber ever receives a
//!   chain with a frame missing in the middle.
//! - `pump` receives the RTP and RTCP, and sends keyframe requests (PLI and FIR) and receiver
//!   reports back to the phone.

use idevice::core_device::{
    HevcDepacketizer, ReportBlock, RtpPacket, SenderReport, build_keyframe_request,
    build_liveness, is_rtcp,
};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{Notify, broadcast, watch},
    time::Instant,
};

const NAL_VPS: u8 = 32;
const NAL_SPS: u8 = 33;
const NAL_PPS: u8 = 34;
const NAL_AUD: u8 = 35;
/// At most this many frames, or bytes, follow the cached key frame. Past either, the chain is
/// dropped and new subscribers wait for the next key frame.
const CHAIN_FRAMES: usize = 900;
const CHAIN_BYTES: usize = 24 * 1024 * 1024;
/// Frames a subscriber may fall behind the phone before it skips to the next key frame.
const LAG_FRAMES: usize = 512;
/// A keyframe request is sent at most this often.
pub const KEYFRAME_INTERVAL: Duration = Duration::from_secs(1);
/// A key frame asked for and not received within this long restarts the media session, which
/// always starts with one (remote.rs).
pub const KEYFRAME_OVERDUE: Duration = Duration::from_secs(2);
/// A subscriber whose reader stops taking frames for this long is dropped.
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

pub const FLAG_KEY: u8 = 1;
pub const FLAG_CONFIG: u8 = 2;
/// The first frame of a new media session: a decoder must start over.
pub const FLAG_RESET: u8 = 4;

/// One HEVC access unit in Annex-B framing.
#[derive(Debug)]
pub struct Frame {
    /// Increases by one per frame across media sessions, so a reader can tell a gap.
    pub seq: u64,
    /// Presentation time from the RTP clock (90 kHz), in microseconds.
    pub pts_us: u64,
    pub key: bool,
    pub reset: bool,
    /// VPS, SPS and PPS in Annex-B, on key frames.
    pub config: Option<Arc<[u8]>>,
    /// The access unit, parameter sets included on key frames, without access unit delimiters.
    pub data: Arc<[u8]>,
}

impl Frame {
    /// `u32 length | u8 flags | u64 seq | u64 pts_us | u16 config length | config | Annex-B`,
    /// big-endian; the length counts every byte after itself.
    pub fn encode(&self) -> Vec<u8> {
        let config = self.config.as_deref().unwrap_or(&[]);
        let length = 1 + 8 + 8 + 2 + config.len() + self.data.len();
        let mut out = Vec::with_capacity(4 + length);
        out.extend_from_slice(&(length as u32).to_be_bytes());
        let mut flags = 0;
        if self.key {
            flags |= FLAG_KEY;
        }
        if self.config.is_some() {
            flags |= FLAG_CONFIG;
        }
        if self.reset {
            flags |= FLAG_RESET;
        }
        out.push(flags);
        out.extend_from_slice(&self.seq.to_be_bytes());
        out.extend_from_slice(&self.pts_us.to_be_bytes());
        out.extend_from_slice(&(config.len() as u16).to_be_bytes());
        out.extend_from_slice(config);
        out.extend_from_slice(&self.data);
        out
    }

    fn bytes(&self) -> usize {
        self.data.len() + self.config.as_ref().map_or(0, |c| c.len())
    }
}

/// The NAL units of an Annex-B stream, without their start codes.
pub fn nal_units(annexb: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= annexb.len() {
        if annexb[i] == 0 && annexb[i + 1] == 0 && annexb[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    starts
        .iter()
        .enumerate()
        .map(|(n, &start)| {
            let mut end = starts.get(n + 1).map_or(annexb.len(), |&next| next - 3);
            // A four-byte start code leaves its leading zero on the previous unit.
            while end > start && n + 1 < starts.len() && annexb[end - 1] == 0 {
                end -= 1;
            }
            &annexb[start..end]
        })
        .filter(|nal| nal.len() >= 2)
        .collect()
}

pub fn nal_type(nal: &[u8]) -> u8 {
    (nal[0] >> 1) & 0x3f
}

fn is_irap(t: u8) -> bool {
    (16..=23).contains(&t)
}

fn annexb(nals: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::with_capacity(nals.iter().map(|n| n.len() + 4).sum());
    for nal in nals {
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(nal);
    }
    out
}

/// Turns the RTP packets of one media session into access units.
pub struct Assembler {
    depacketizer: HevcDepacketizer,
    expected: Option<u16>,
    current: Vec<Vec<u8>>,
    current_ts: u32,
    /// Waiting for a key frame: at the start, and after a lost packet.
    damaged: bool,
    vps: Option<Vec<u8>>,
    sps: Option<Vec<u8>>,
    pps: Option<Vec<u8>>,
    clock: Option<(u32, u64)>,
    first: bool,
}

impl Default for Assembler {
    fn default() -> Self {
        Self::new()
    }
}

impl Assembler {
    pub fn new() -> Self {
        Self {
            depacketizer: HevcDepacketizer::new(),
            expected: None,
            current: Vec::new(),
            current_ts: 0,
            damaged: true,
            vps: None,
            sps: None,
            pps: None,
            clock: None,
            first: true,
        }
    }

    /// Feeds one RTP packet. Returns the access units it completed (in order, without sequence
    /// numbers; the hub numbers them) and whether a packet was lost, which calls for a key frame.
    pub fn push(&mut self, seq: u16, ts: u32, marker: bool, payload: &[u8]) -> (Vec<Frame>, bool) {
        let mut lost = false;
        if let Some(expected) = self.expected {
            if seq != expected {
                if expected.wrapping_sub(seq) < 0x8000 {
                    // A duplicate or a late packet: already past it.
                    return (Vec::new(), false);
                }
                // The tunnel does not reorder, so a jump is a loss. The depacketizer would wait
                // for the missing packet and then join fragments across the hole; a new one
                // starts clean, and the parameter sets stay cached here.
                self.depacketizer = HevcDepacketizer::new();
                self.current.clear();
                self.damaged = true;
                lost = true;
            }
        }
        self.expected = Some(seq.wrapping_add(1));
        self.depacketizer.push(seq, ts, payload);
        let output = self.depacketizer.take_output();
        let mut frames = Vec::new();
        for nal in nal_units(&output) {
            if nal_type(nal) == NAL_AUD {
                if let Some(frame) = self.finish() {
                    frames.push(frame);
                }
                continue;
            }
            if self.current.is_empty() {
                self.current_ts = ts;
            }
            self.current.push(nal.to_vec());
        }
        if marker && let Some(frame) = self.finish() {
            frames.push(frame);
        }
        (frames, lost)
    }

    fn pts_us(&mut self, ts: u32) -> u64 {
        let extended = match self.clock {
            None => ts as u64,
            Some((last, extended)) => {
                let delta = ts.wrapping_sub(last) as i32 as i64;
                (extended as i64 + delta).max(0) as u64
            }
        };
        self.clock = Some((ts, extended));
        extended * 100 / 9
    }

    fn finish(&mut self) -> Option<Frame> {
        if self.current.is_empty() {
            return None;
        }
        let nals = std::mem::take(&mut self.current);
        let pts_us = self.pts_us(self.current_ts);
        let key = nals.iter().any(|n| is_irap(nal_type(n)));
        for nal in &nals {
            match nal_type(nal) {
                NAL_VPS => self.vps = Some(nal.clone()),
                NAL_SPS => self.sps = Some(nal.clone()),
                NAL_PPS => self.pps = Some(nal.clone()),
                _ => {}
            }
        }
        if !key && self.damaged {
            return None;
        }
        let (Some(vps), Some(sps), Some(pps)) = (&self.vps, &self.sps, &self.pps) else {
            // A key frame without parameter sets cannot start a decoder.
            self.damaged = true;
            return None;
        };
        let mut units: Vec<&[u8]> = Vec::with_capacity(nals.len() + 3);
        let config = if key {
            self.damaged = false;
            let has = |t| nals.iter().any(|n| nal_type(n) == t);
            if !(has(NAL_VPS) && has(NAL_SPS) && has(NAL_PPS)) {
                units.extend([vps.as_slice(), sps.as_slice(), pps.as_slice()]);
            }
            Some(Arc::from(annexb(&[vps, sps, pps])))
        } else {
            None
        };
        units.extend(nals.iter().map(Vec::as_slice));
        let reset = std::mem::take(&mut self.first) && key;
        Some(Frame {
            seq: 0,
            pts_us,
            key,
            reset,
            config,
            data: Arc::from(annexb(&units)),
        })
    }
}

/// Removes the emulation prevention bytes of a NAL unit's payload.
fn rbsp(nal: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(nal.len());
    let mut zeros = 0;
    for &byte in nal {
        if zeros >= 2 && byte == 3 {
            zeros = 0;
            continue;
        }
        zeros = if byte == 0 { zeros + 1 } else { 0 };
        out.push(byte);
    }
    out
}

struct Bits<'a> {
    data: &'a [u8],
    at: usize,
}

impl Bits<'_> {
    fn bit(&mut self) -> Option<u32> {
        let byte = *self.data.get(self.at / 8)?;
        let bit = (byte >> (7 - self.at % 8)) & 1;
        self.at += 1;
        Some(bit as u32)
    }
    fn bits(&mut self, n: usize) -> Option<u32> {
        let mut value = 0;
        for _ in 0..n {
            value = (value << 1) | self.bit()?;
        }
        Some(value)
    }
    fn skip(&mut self, n: usize) -> Option<()> {
        self.at += n;
        (self.at <= self.data.len() * 8).then_some(())
    }
    fn ue(&mut self) -> Option<u32> {
        let mut zeros = 0;
        while self.bit()? == 0 {
            zeros += 1;
            if zeros > 31 {
                return None;
            }
        }
        Some((1u32 << zeros) - 1 + self.bits(zeros)?)
    }
}

/// The displayed width and height an HEVC SPS (the NAL unit, header included) describes.
pub fn hevc_dimensions(sps: &[u8]) -> Option<(u32, u32)> {
    let data = rbsp(sps.get(2..)?);
    let mut bits = Bits { data: &data, at: 0 };
    bits.skip(4)?;
    let sub_layers = bits.bits(3)? as usize;
    bits.skip(1)?;
    // profile_tier_level: the general profile (88 bits) and level (8 bits), then the sub-layers.
    bits.skip(88 + 8)?;
    let mut present = Vec::with_capacity(sub_layers);
    for _ in 0..sub_layers {
        present.push((bits.bit()? == 1, bits.bit()? == 1));
    }
    if sub_layers > 0 {
        bits.skip(2 * (8 - sub_layers))?;
    }
    for (profile, level) in present {
        if profile {
            bits.skip(88)?;
        }
        if level {
            bits.skip(8)?;
        }
    }
    bits.ue()?;
    let chroma = bits.ue()?;
    if chroma == 3 {
        bits.skip(1)?;
    }
    let width = bits.ue()?;
    let height = bits.ue()?;
    let (mut width, mut height) = (width, height);
    if bits.bit()? == 1 {
        let (sub_w, sub_h) = match chroma {
            1 => (2, 2),
            2 => (2, 1),
            _ => (1, 1),
        };
        let (left, right, top, bottom) = (bits.ue()?, bits.ue()?, bits.ue()?, bits.ue()?);
        width = width.checked_sub(sub_w * (left + right))?;
        height = height.checked_sub(sub_h * (top + bottom))?;
    }
    (width > 0 && height > 0 && width <= 16384 && height <= 16384).then_some((width, height))
}

#[derive(Default)]
struct Chain {
    frames: VecDeque<Arc<Frame>>,
    bytes: usize,
}

struct HubState {
    chain: Chain,
    next_seq: u64,
    size: Option<(u32, u32)>,
    /// When a key frame was first asked for and not yet received.
    wanted_since: Option<Instant>,
}

/// The screen video of one phone, shared by its subscribers.
pub struct VideoHub {
    state: Mutex<HubState>,
    frames: broadcast::Sender<Arc<Frame>>,
    subscribers: watch::Sender<usize>,
    keyframe: Notify,
    closed: watch::Sender<bool>,
}

impl Default for VideoHub {
    fn default() -> Self {
        Self::new()
    }
}

impl VideoHub {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(HubState {
                chain: Chain::default(),
                next_seq: 1,
                size: None,
                wanted_since: None,
            }),
            frames: broadcast::channel(LAG_FRAMES).0,
            subscribers: watch::Sender::new(0),
            keyframe: Notify::new(),
            closed: watch::Sender::new(false),
        }
    }

    /// The helper's session ends: every subscriber's stream ends with it.
    pub fn close(&self) {
        self.closed.send_replace(true);
    }

    pub fn subscribers(&self) -> usize {
        *self.subscribers.borrow()
    }

    /// Changes whenever a subscriber comes or goes.
    pub fn watch(&self) -> watch::Receiver<usize> {
        self.subscribers.subscribe()
    }

    /// The width and height of the latest key frame.
    pub fn size(&self) -> Option<(u32, u32)> {
        self.state.lock().unwrap().size
    }

    /// A new media session begins: frames cached from the previous one cannot start a decoder of
    /// the next.
    pub fn media_started(&self) {
        let mut state = self.state.lock().unwrap();
        state.chain = Chain::default();
    }

    pub fn publish(&self, mut frame: Frame) {
        let mut state = self.state.lock().unwrap();
        frame.seq = state.next_seq;
        state.next_seq += 1;
        if frame.key {
            state.chain = Chain::default();
            state.wanted_since = None;
            if let Some(size) = frame
                .config
                .as_deref()
                .and_then(|c| nal_units(c).into_iter().find(|n| nal_type(n) == NAL_SPS))
                .and_then(hevc_dimensions)
            {
                state.size = Some(size);
            }
        }
        let frame = Arc::new(frame);
        if frame.key || !state.chain.frames.is_empty() {
            state.chain.bytes += frame.bytes();
            state.chain.frames.push_back(frame.clone());
            if state.chain.frames.len() > CHAIN_FRAMES || state.chain.bytes > CHAIN_BYTES {
                // Too long to replay: the next subscriber waits for a fresh key frame instead.
                state.chain = Chain::default();
            }
        }
        // Sent under the lock, so a subscription taken between two frames gets each exactly once.
        let _ = self.frames.send(frame);
    }

    /// Asks the phone for a key frame (sent by `pump`, at most once per KEYFRAME_INTERVAL).
    pub fn want_keyframe(&self) {
        let mut state = self.state.lock().unwrap();
        state.wanted_since.get_or_insert_with(Instant::now);
        drop(state);
        self.keyframe.notify_one();
    }

    pub fn keyframe_wanted(&self) -> bool {
        self.state.lock().unwrap().wanted_since.is_some()
    }

    /// A key frame was asked for KEYFRAME_OVERDUE ago and has not come.
    pub fn keyframe_overdue(&self, now: Instant) -> bool {
        self.state
            .lock()
            .unwrap()
            .wanted_since
            .is_some_and(|since| now.duration_since(since) >= KEYFRAME_OVERDUE)
    }

    /// Forgets an unanswered request, once the media session restarts (it begins with a key frame).
    pub fn clear_keyframe_request(&self) {
        self.state.lock().unwrap().wanted_since = None;
    }

    #[cfg(test)]
    pub fn cached_frames(&self) -> usize {
        self.state.lock().unwrap().chain.frames.len()
    }

    pub fn subscribe(self: &Arc<Self>) -> Subscription {
        let state = self.state.lock().unwrap();
        let backlog: Vec<_> = state.chain.frames.iter().cloned().collect();
        let frames = self.frames.subscribe();
        drop(state);
        self.subscribers.send_modify(|count| *count += 1);
        Subscription {
            hub: self.clone(),
            backlog,
            frames,
        }
    }
}

/// One subscriber's frames: the cached chain, then the live ones.
pub struct Subscription {
    hub: Arc<VideoHub>,
    backlog: Vec<Arc<Frame>>,
    frames: broadcast::Receiver<Arc<Frame>>,
}

#[cfg(test)]
impl Subscription {
    pub fn backlog_len(&self) -> usize {
        self.backlog.len()
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.hub.subscribers.send_modify(|count| *count -= 1);
    }
}

impl Subscription {
    /// Writes frames to `stream` until the reader closes it, stops reading, or the hub closes.
    /// A reader that falls behind loses frames up to the next key frame, never a frame inside a
    /// chain it is decoding.
    pub async fn serve<S: AsyncRead + AsyncWrite + Unpin>(mut self, stream: &mut S) {
        let backlog = std::mem::take(&mut self.backlog);
        let mut waiting = backlog.first().is_none_or(|frame| !frame.key);
        if waiting {
            self.hub.want_keyframe();
        }
        let mut last_seq = 0;
        for frame in backlog {
            if !write(stream, &frame).await {
                return;
            }
            last_seq = frame.seq;
        }
        let mut byte = [0u8; 64];
        let mut closed = self.hub.closed.subscribe();
        if *closed.borrow_and_update() {
            return;
        }
        loop {
            tokio::select! {
                biased;
                _ = closed.changed() => return,
                read = stream.read(&mut byte) => {
                    // The reader sends nothing; EOF or an error is the end. Static screens send no
                    // frames, so a closed reader is noticed here, not by a failed write.
                    if !matches!(read, Ok(n) if n > 0) {
                        return;
                    }
                }
                received = self.frames.recv() => match received {
                    Ok(frame) => {
                        if frame.seq <= last_seq {
                            continue;
                        }
                        if waiting && !frame.key {
                            continue;
                        }
                        if !waiting && frame.seq != last_seq + 1 && !frame.key && last_seq != 0 {
                            // Defensive: a hole in the chain is never passed on.
                            waiting = true;
                            self.hub.want_keyframe();
                            continue;
                        }
                        waiting = false;
                        if !write(stream, &frame).await {
                            return;
                        }
                        last_seq = frame.seq;
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        waiting = true;
                        self.hub.want_keyframe();
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                },
            }
        }
    }
}

async fn write<S: AsyncWrite + Unpin>(stream: &mut S, frame: &Frame) -> bool {
    let bytes = frame.encode();
    matches!(
        tokio::time::timeout(WRITE_TIMEOUT, async {
            stream.write_all(&bytes).await?;
            stream.flush().await
        })
        .await,
        Ok(Ok(()))
    )
}

/// One datagram received on the tunnel.
pub struct Datagram {
    pub source_port: u16,
    pub data: Vec<u8>,
}

/// Where `pump` receives video and sends RTCP.
pub enum Source {
    Udp(idevice::tcp::handle::UdpSocketHandle),
    /// Tests: datagrams to receive, and the RTCP sent.
    #[cfg(test)]
    Test {
        incoming: tokio::sync::mpsc::UnboundedReceiver<Datagram>,
        sent: tokio::sync::mpsc::UnboundedSender<(u16, Vec<u8>)>,
    },
}

impl Source {
    async fn recv(&mut self) -> Option<Datagram> {
        match self {
            Self::Udp(socket) => socket.recv().await.ok().map(|d| Datagram {
                source_port: d.source_port,
                data: d.data,
            }),
            #[cfg(test)]
            Self::Test { incoming, .. } => incoming.recv().await,
        }
    }
    async fn send(&mut self, port: u16, data: Vec<u8>) {
        match self {
            Self::Udp(socket) => {
                let _ = socket.send_to(port, data).await;
            }
            #[cfg(test)]
            Self::Test { sent, .. } => {
                let _ = sent.send((port, data));
            }
        }
    }
}

/// The RTCP side of one media session.
pub struct Feedback {
    pub our_ssrc: u32,
    /// Where RTCP goes until the phone's own RTCP shows its port.
    pub sender_port: u16,
}

/// Receives one media session's video until its socket closes, and answers it with RTCP.
/// `alive` turns false when it stops.
pub async fn pump(mut source: Source, hub: Arc<VideoHub>, feedback: Feedback, alive: Arc<AtomicBool>) {
    hub.media_started();
    let mut assembler = Assembler::new();
    let mut media_ssrc: Option<u32> = None;
    let mut rtcp_port: Option<u16> = None;
    let mut highest: Option<(u16, u32)> = None;
    let mut requested: Option<Instant> = None;
    let mut fir_seq: u8 = 0;
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let cname = "poki-mcp";
    enum Action {
        Keyframe,
        Report,
    }
    loop {
        let action = tokio::select! {
            datagram = source.recv() => {
                let Some(datagram) = datagram else { break };
                if is_rtcp(&datagram.data) {
                    // RTCP shares the tunnel's UDP socket; it must not reach the depacketizer.
                    if let Some(report) = SenderReport::parse_first(&datagram.data) {
                        media_ssrc.get_or_insert(report.ssrc);
                    }
                    rtcp_port = Some(datagram.source_port);
                    continue;
                }
                let Some(packet) = RtpPacket::parse(&datagram.data) else { continue };
                media_ssrc = Some(packet.ssrc);
                let seq = packet.sequence_number;
                highest = Some(match highest {
                    None => (seq, 0),
                    // Newer than the highest so far; numerically smaller means it wrapped.
                    Some((last, cycles)) if seq.wrapping_sub(last) < 0x8000 => (seq, if seq < last { cycles + 1 } else { cycles }),
                    Some(previous) => previous,
                });
                let (frames, lost) = assembler.push(seq, packet.timestamp, packet.marker, packet.payload);
                for frame in frames {
                    hub.publish(frame);
                }
                if lost {
                    hub.want_keyframe();
                }
                continue;
            }
            () = hub.keyframe.notified() => Action::Keyframe,
            _ = tick.tick() => if hub.keyframe_wanted() { Action::Keyframe } else { Action::Report },
        };
        let port = rtcp_port.unwrap_or(feedback.sender_port);
        let blocks: Vec<ReportBlock> = match (media_ssrc, highest) {
            (Some(ssrc), Some((seq, cycles))) => vec![ReportBlock {
                source_ssrc: ssrc,
                highest_seq: (cycles << 16) | seq as u32,
                ..Default::default()
            }],
            _ => Vec::new(),
        };
        let Some(ssrc) = media_ssrc else { continue };
        match action {
            Action::Keyframe => {
                let now = Instant::now();
                if hub.keyframe_wanted()
                    && requested.is_none_or(|at| now.duration_since(at) >= KEYFRAME_INTERVAL)
                {
                    requested = Some(now);
                    fir_seq = fir_seq.wrapping_add(1);
                    source
                        .send(
                            port,
                            build_keyframe_request(feedback.our_ssrc, cname, ssrc, &blocks, fir_seq),
                        )
                        .await;
                }
            }
            // Receiver reports while someone watches, as a screen-sharing receiver sends them.
            Action::Report if hub.subscribers() > 0 => {
                source
                    .send(port, build_liveness(feedback.our_ssrc, cname, &blocks))
                    .await;
            }
            Action::Report => {}
        }
    }
    alive.store(false, Ordering::Release);
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// The sample stream in tests/fixtures (180x390, 8 frames, a key frame every 4).
    pub fn sample() -> Vec<u8> {
        std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/sample.h265")).unwrap()
    }

    /// Packetizes an Annex-B HEVC stream as the phone does (RFC 7798): parameter sets in one
    /// aggregation packet, NAL units over 1200 bytes in fragmentation units, the marker on the
    /// last packet of each access unit. Returns one Vec of RTP packets per access unit.
    pub fn packetize(stream: &[u8], ssrc: u32, first_seq: u16) -> Vec<Vec<Vec<u8>>> {
        let mut units: Vec<Vec<&[u8]>> = Vec::new();
        let mut current: Vec<&[u8]> = Vec::new();
        for nal in nal_units(stream) {
            let t = nal_type(nal);
            // A VPS, or a VCL unit after one, starts a new access unit in this sample.
            if (t == NAL_VPS || (t <= 31 && current.iter().any(|n| nal_type(n) <= 31)))
                && !current.is_empty()
            {
                units.push(std::mem::take(&mut current));
            }
            current.push(nal);
        }
        units.push(current);
        let mut seq = first_seq;
        units
            .iter()
            .enumerate()
            .map(|(index, nals)| {
                let ts = (index as u32) * 9000;
                let mut payloads: Vec<Vec<u8>> = Vec::new();
                let params: Vec<&[u8]> = nals
                    .iter()
                    .copied()
                    .filter(|n| (NAL_VPS..=NAL_PPS).contains(&nal_type(n)))
                    .collect();
                if !params.is_empty() {
                    let mut ap = vec![48 << 1, 1];
                    for p in &params {
                        ap.extend_from_slice(&(p.len() as u16).to_be_bytes());
                        ap.extend_from_slice(p);
                    }
                    payloads.push(ap);
                }
                for nal in nals.iter().filter(|n| !(NAL_VPS..=NAL_PPS).contains(&nal_type(n))) {
                    if nal.len() <= 1200 {
                        payloads.push(nal.to_vec());
                        continue;
                    }
                    let body = &nal[2..];
                    let chunks: Vec<&[u8]> = body.chunks(1000).collect();
                    for (i, chunk) in chunks.iter().enumerate() {
                        let mut fu = vec![(nal[0] & 0x81) | (49 << 1), nal[1]];
                        let mut header = nal_type(nal);
                        if i == 0 {
                            header |= 0x80;
                        }
                        if i + 1 == chunks.len() {
                            header |= 0x40;
                        }
                        fu.push(header);
                        fu.extend_from_slice(chunk);
                        payloads.push(fu);
                    }
                }
                let count = payloads.len();
                payloads
                    .into_iter()
                    .enumerate()
                    .map(|(i, payload)| {
                        let marker = if i + 1 == count { 0x80 } else { 0 };
                        let mut packet = vec![0x80, marker | 100];
                        packet.extend_from_slice(&seq.to_be_bytes());
                        packet.extend_from_slice(&ts.to_be_bytes());
                        packet.extend_from_slice(&ssrc.to_be_bytes());
                        packet.extend_from_slice(&payload);
                        seq = seq.wrapping_add(1);
                        packet
                    })
                    .collect()
            })
            .collect()
    }

    fn feed(assembler: &mut Assembler, packets: &[Vec<u8>]) -> (Vec<Frame>, bool) {
        let mut frames = Vec::new();
        let mut lost = false;
        for packet in packets {
            let p = RtpPacket::parse(packet).unwrap();
            let (out, l) = assembler.push(p.sequence_number, p.timestamp, p.marker, p.payload);
            frames.extend(out);
            lost |= l;
        }
        (frames, lost)
    }

    #[test]
    fn access_units_come_out_whole_with_key_frames_marked() {
        let units = packetize(&sample(), 7, 65530);
        assert_eq!(units.len(), 8);
        let mut assembler = Assembler::new();
        let (frames, lost) = feed(&mut assembler, &units.concat());
        assert!(!lost);
        let keys: Vec<bool> = frames.iter().map(|f| f.key).collect();
        assert_eq!(keys, [true, false, false, false, true, false, false, false]);
        assert!(frames[0].reset && !frames[4].reset);
        // The stream across the sequence wrap reassembles to the original bytes.
        let joined: Vec<u8> = frames.iter().flat_map(|f| f.data.iter().copied()).collect();
        let stream = sample();
        let original: Vec<&[u8]> = nal_units(&stream);
        assert_eq!(nal_units(&joined), original);
        assert_eq!(frames[1].pts_us - frames[0].pts_us, 100_000);
        let config = frames[0].config.as_ref().unwrap();
        let types: Vec<u8> = nal_units(config).iter().map(|n| nal_type(n)).collect();
        assert_eq!(types, [NAL_VPS, NAL_SPS, NAL_PPS]);
    }

    #[test]
    fn a_lost_packet_drops_the_frames_up_to_the_next_key_frame() {
        let units = packetize(&sample(), 7, 100);
        let mut assembler = Assembler::new();
        let (first, _) = feed(&mut assembler, &units[..2].concat());
        assert_eq!(first.len(), 2);
        // The first packet of frame 3 never arrives.
        let mut rest = units[2][1..].to_vec();
        for unit in &units[3..] {
            rest.extend(unit.iter().cloned());
        }
        let (frames, lost) = feed(&mut assembler, &rest);
        assert!(lost);
        assert!(frames[0].key, "a frame of the broken chain was emitted");
        assert_eq!(frames.len(), 4);
    }

    #[test]
    fn duplicates_are_ignored_and_the_stream_waits_for_its_first_key_frame() {
        let units = packetize(&sample(), 7, 0);
        let mut assembler = Assembler::new();
        // Joining at frame 2: nothing until the key frame at 4.
        let (frames, _) = feed(&mut assembler, &units[2..5].concat());
        assert_eq!(frames.len(), 1);
        assert!(frames[0].key);
        let (again, lost) = feed(&mut assembler, &units[4]);
        assert!(again.is_empty() && !lost);
    }

    fn frames_of_sample() -> Vec<Frame> {
        let mut assembler = Assembler::new();
        feed(&mut assembler, &packetize(&sample(), 7, 0).concat()).0
    }

    fn copy(frame: &Frame) -> Frame {
        Frame {
            seq: 0,
            pts_us: frame.pts_us,
            key: frame.key,
            reset: false,
            config: frame.config.clone(),
            data: frame.data.clone(),
        }
    }

    async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> Option<(u8, u64)> {
        let mut length = [0u8; 4];
        reader.read_exact(&mut length).await.ok()?;
        let mut frame = vec![0u8; u32::from_be_bytes(length) as usize];
        reader.read_exact(&mut frame).await.ok()?;
        Some((frame[0], u64::from_be_bytes(frame[1..9].try_into().unwrap())))
    }

    // A subscriber that cannot keep up loses frames only up to a key frame: every frame it gets
    // after a gap is a key frame.
    #[tokio::test]
    async fn a_lagging_subscriber_resumes_at_the_next_key_frame() {
        let hub = Arc::new(VideoHub::new());
        let sample = frames_of_sample();
        let (mut reader, mut writer) = tokio::io::duplex(64);
        let subscription = hub.subscribe();
        let server = tokio::spawn(async move { subscription.serve(&mut writer).await });
        for round in 0..(LAG_FRAMES / sample.len() + 4) {
            for frame in &sample {
                let _ = round;
                hub.publish(copy(frame));
            }
        }
        let total = ((LAG_FRAMES / sample.len() + 4) * sample.len()) as u64;
        let mut received = Vec::new();
        while let Some((flags, seq)) = read_frame(&mut reader).await {
            received.push((flags, seq));
            if seq == total {
                break;
            }
        }
        assert!(received.len() < total as usize, "the subscriber never lagged");
        assert!(received[0].0 & FLAG_KEY != 0);
        for pair in received.windows(2) {
            let ((_, before), (flags, after)) = (pair[0], pair[1]);
            assert!(
                after == before + 1 || flags & FLAG_KEY != 0,
                "frame {after} follows {before} without a key frame"
            );
        }
        assert!(hub.keyframe_wanted(), "the lag did not ask for a key frame");
        drop(reader);
        server.await.unwrap();
        assert_eq!(hub.subscribers(), 0);
    }

    // A still screen sends nothing, so the subscriber must notice its reader leaving without a
    // failed write. A subscriber without a cached key frame asks for one and starts there.
    #[tokio::test]
    async fn a_subscriber_without_a_key_frame_waits_for_one_and_leaves_with_its_reader() {
        let hub = Arc::new(VideoHub::new());
        let sample = frames_of_sample();
        // Only deltas so far: nothing a decoder could start from.
        hub.publish(copy(&sample[1]));
        let (mut reader, mut writer) = tokio::io::duplex(1 << 20);
        let subscription = hub.subscribe();
        let server = tokio::spawn(async move { subscription.serve(&mut writer).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(hub.keyframe_wanted());
        hub.publish(copy(&sample[2]));
        hub.publish(copy(&sample[4]));
        hub.publish(copy(&sample[5]));
        let first = read_frame(&mut reader).await.unwrap();
        assert!(first.0 & FLAG_KEY != 0, "the first frame was not a key frame");
        assert!(!hub.keyframe_wanted(), "the key frame did not answer the request");
        assert_eq!(read_frame(&mut reader).await.unwrap().1, first.1 + 1);
        assert_eq!(hub.subscribers(), 1);
        drop(reader);
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .expect("the subscriber outlived its reader")
            .unwrap();
        assert_eq!(hub.subscribers(), 0);
    }

    // A new subscriber replays the cached chain from its key frame; closing the hub ends it.
    #[tokio::test]
    async fn a_new_subscriber_starts_at_the_cached_key_frame_and_ends_with_the_hub() {
        let hub = Arc::new(VideoHub::new());
        for frame in &frames_of_sample()[..7] {
            hub.publish(copy(frame));
        }
        let (mut reader, mut writer) = tokio::io::duplex(1 << 20);
        let subscription = hub.subscribe();
        let server = tokio::spawn(async move { subscription.serve(&mut writer).await });
        let seqs: Vec<u64> = [
            read_frame(&mut reader).await.unwrap(),
            read_frame(&mut reader).await.unwrap(),
            read_frame(&mut reader).await.unwrap(),
        ]
        .iter()
        .map(|f| f.1)
        .collect();
        assert_eq!(seqs, [5, 6, 7], "the replay did not start at the latest key frame");
        hub.close();
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .expect("closing the hub did not end the subscriber")
            .unwrap();
        assert!(read_frame(&mut reader).await.is_none());
    }

    #[test]
    fn dimensions_come_from_the_sps() {
        let sps = nal_units(&sample())
            .into_iter()
            .find(|n| nal_type(n) == NAL_SPS)
            .unwrap()
            .to_vec();
        assert_eq!(hevc_dimensions(&sps), Some((180, 390)));
    }
}
