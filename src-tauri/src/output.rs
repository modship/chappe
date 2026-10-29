//! Delivery of terminal output to the webview.
//!
//! Bytes are pushed through a binary Tauri `Channel` (no JSON, no base64).
//! Small chunks are interactive echo and go out at once; during a flood the
//! pump waits a few milliseconds so the renderer gets fewer, bigger frames.

use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use tauri::ipc::{Channel, InvokeResponseBody};

/// Chunks smaller than this are interactive echo: send them right away.
const INTERACTIVE_CHUNK: usize = 4 * 1024;
/// While a flood is in progress, wait this long to coalesce more output.
const COALESCE_WINDOW: Duration = Duration::from_millis(4);
/// Never hand the webview more than this in one message.
const MAX_BATCH: usize = 512 * 1024;

/// Sending side of the pump. Dropping it flushes what is left and stops the
/// pump thread, which then fires the `drained` signal.
pub type OutputSender = mpsc::Sender<Vec<u8>>;

pub struct Pump {
    pub sender: OutputSender,
    pub drained: tokio::sync::oneshot::Receiver<()>,
}

pub fn spawn_pump(name: String, on_data: Channel<InvokeResponseBody>) -> std::io::Result<Pump> {
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let (drained_tx, drained_rx) = tokio::sync::oneshot::channel();

    thread::Builder::new().name(name).spawn(move || {
        while let Ok(mut batch) = rx.recv() {
            // Pick up whatever is already queued without waiting.
            while batch.len() < MAX_BATCH {
                match rx.try_recv() {
                    Ok(more) => batch.extend_from_slice(&more),
                    Err(_) => break,
                }
            }
            if batch.len() >= INTERACTIVE_CHUNK {
                let deadline = Instant::now() + COALESCE_WINDOW;
                while batch.len() < MAX_BATCH {
                    let left = deadline.saturating_duration_since(Instant::now());
                    match rx.recv_timeout(left) {
                        Ok(more) => batch.extend_from_slice(&more),
                        Err(_) => break,
                    }
                }
            }
            if on_data.send(InvokeResponseBody::Raw(batch)).is_err() {
                break;
            }
        }
        let _ = drained_tx.send(());
    })?;

    Ok(Pump {
        sender: tx,
        drained: drained_rx,
    })
}
