use crate::{
    admission::{Scheduler, Ticket, lock},
    error::Error,
};
use futures_util::task::AtomicWaker;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    task::{Context, Poll},
    time::{Duration, Instant},
};
use wreq::{
    Uri,
    socket::{SocketLease, SocketObserver, SocketReservation},
};

/// How often a reservation blocked on global TCP capacity re-checks for idle
/// sockets that became evictable after it started waiting.
const EVICTION_RETRY: Duration = Duration::from_millis(50);

#[derive(Clone)]
pub(crate) struct Connections {
    inner: Arc<Inner>,
}
struct Inner {
    scheduler: Arc<Scheduler>,
    // Operation admission of the owning client. Its busy origins are the only
    // ones whose pooled sockets may be serving a request.
    operations: Option<Arc<Scheduler>>,
    records: Mutex<HashMap<u64, Weak<Record>>>,
    closed: AtomicBool,
    next_id: AtomicU64,
    epoch: Instant,
    // Woken whenever a socket record goes away.
    drained: tokio::sync::Notify,
}
struct Record {
    owner: Arc<Inner>,
    id: u64,
    origin: String,
    // The observed stream/future closes its socket before dropping this lease.
    ticket: Ticket,
    established: AtomicBool,
    closing: AtomicBool,
    // Nanoseconds since `Inner::epoch` of the latest read/write poll. An idle
    // pooled socket stops being polled, so this orders eviction LRU-first.
    last_poll_ns: AtomicU64,
    read: AtomicWaker,
    write: AtomicWaker,
}
impl Connections {
    pub fn new(
        max: usize,
        per_origin: usize,
        max_operations: usize,
        operations: Option<Arc<Scheduler>>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                scheduler: Scheduler::new(max, max_operations * 6, per_origin),
                operations,
                records: Mutex::new(HashMap::new()),
                closed: AtomicBool::new(false),
                next_id: AtomicU64::new(1),
                epoch: Instant::now(),
                drained: tokio::sync::Notify::new(),
            }),
        }
    }
    pub fn close(&self) {
        self.inner.closed.store(true, Ordering::SeqCst);
        self.inner.scheduler.stop();
        // Do not keep a map lock while dropping upgraded weak references:
        // the last reference removes itself from this map on Drop.
        let records = lock(&self.inner.records)
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for weak in records {
            if let Some(record) = weak.upgrade() {
                record.request_close();
            }
        }
    }
    /// Resolves after a socket record is dropped.
    pub fn drained(&self) -> tokio::sync::futures::Notified<'_> {
        self.inner.drained.notified()
    }
    pub fn is_empty(&self) -> bool {
        self.inner.scheduler.counts() == (0, 0)
    }
    pub fn stats(&self) -> Value {
        let admission = self.inner.scheduler.stats();
        let records = lock(&self.inner.records)
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let established = records
            .into_iter()
            .filter_map(|w| w.upgrade())
            .filter(|r| r.established.load(Ordering::SeqCst))
            .count();
        let count = admission["activeOperations"].as_u64().unwrap_or(0) as usize;
        json!({"connections":count,"creatingConnections":count.saturating_sub(established),
            "waitingConnections":admission["queuedOperations"],
            "connectionOrigins":admission["origins"].as_array().expect("origin counters").iter().map(|o| json!({
                "origin":o["origin"],"connections":o["activeOperations"],"waitingConnections":o["waitingOperations"]
            })).collect::<Vec<_>>()})
    }
}
impl SocketObserver for Connections {
    fn reserve(&self, origin: &Uri, _peer: SocketAddr) -> SocketReservation {
        let owner = self.inner.clone();
        let origin = origin.to_string();
        Box::pin(async move {
            if owner.closed.load(Ordering::SeqCst) {
                return Err(closed().into());
            }
            let url = url::Url::parse(&origin).map_err(|_| {
                Error::new("ERR_INVALID_ARGUMENT", "connect", "Invalid socket origin")
            })?;
            let id = owner.next_id.fetch_add(1, Ordering::SeqCst);
            if id > 9007199254740991 {
                return Err(Error::new(
                    "ERR_RESOURCE_LIMIT",
                    "connect",
                    "Socket identifier exhausted",
                )
                .into());
            }
            let origin = url.origin().ascii_serialization();
            let ticket = owner.scheduler.register(id, origin.clone())?;
            {
                let wait = ticket.wait();
                tokio::pin!(wait);
                let retry = tokio::time::sleep(Duration::ZERO);
                tokio::pin!(retry);
                // Granted reservations complete on the first poll. A queued one
                // evicts at once and then periodically, because pooled sockets
                // become idle after their operation ends. Every poll re-checks
                // whether the connect lost the pool race and runs unowned.
                std::future::poll_fn(|cx| {
                    loop {
                        if let Poll::Ready(result) = wait.as_mut().poll(cx) {
                            return Poll::Ready(result);
                        }
                        if wreq::socket::is_raced_connect() {
                            return Poll::Ready(Err(Error::new(
                                "ERR_CONNECT",
                                "connect",
                                "Pool-race connect abandoned before acquiring capacity",
                            )));
                        }
                        if retry.as_mut().poll(cx).is_pending() {
                            return Poll::Pending;
                        }
                        owner.evict_idle();
                        retry
                            .as_mut()
                            .reset(tokio::time::Instant::now() + EVICTION_RETRY);
                    }
                })
                .await?;
            }
            let record = {
                let mut records = lock(&owner.records);
                if owner.closed.load(Ordering::SeqCst) {
                    return Err(closed().into());
                }
                let record = Arc::new(Record {
                    owner: owner.clone(),
                    id,
                    origin,
                    ticket,
                    established: AtomicBool::new(false),
                    closing: AtomicBool::new(false),
                    last_poll_ns: AtomicU64::new(owner.now_ns()),
                    read: AtomicWaker::new(),
                    write: AtomicWaker::new(),
                });
                records.insert(id, Arc::downgrade(&record));
                record
            };
            Ok(record as Arc<dyn SocketLease>)
        })
    }
}
impl Inner {
    fn now_ns(&self) -> u64 {
        self.epoch.elapsed().as_nanos() as u64
    }
    /// Close least-recently-used established sockets of origins with no
    /// operation, until each reservation queued behind the global cap has one
    /// release in flight. Per-origin waits are not helped by closing other
    /// origins, and an idle socket of the waiting origin would have been
    /// reused by the pool instead of reserving a new one.
    ///
    /// An operation may start on a chosen origin between the busy-origin
    /// snapshot and the close request. Its checkout then sees a closing socket,
    /// exactly as when a server closes an idle keep-alive connection.
    fn evict_idle(&self) {
        let Some(operations) = &self.operations else {
            return;
        };
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        // Waiters held back by their own origin's cap gain nothing from
        // closing another origin's idle socket.
        let queued = self.scheduler.globally_blocked();
        if queued == 0 {
            return;
        }
        let records = lock(&self.records)
            .values()
            .filter_map(Weak::upgrade)
            .collect::<Vec<_>>();
        let in_flight = records
            .iter()
            .filter(|r| r.closing.load(Ordering::SeqCst))
            .count();
        let needed = queued.saturating_sub(in_flight);
        if needed == 0 {
            return;
        }
        let busy = operations.busy_origins();
        let mut idle = records
            .into_iter()
            .filter(|r| {
                r.established.load(Ordering::SeqCst)
                    && !r.closing.load(Ordering::SeqCst)
                    && !busy.contains(&r.origin)
            })
            .collect::<Vec<_>>();
        idle.sort_by_key(|r| r.last_poll_ns.load(Ordering::Relaxed));
        for record in idle.into_iter().take(needed) {
            record.request_close();
        }
    }
}
impl Record {
    fn request_close(&self) {
        self.closing.store(true, Ordering::SeqCst);
        self.read.wake();
        self.write.wake();
    }
}
fn closed() -> Error {
    Error::new("ERR_CLIENT_CLOSED", "connect", "Socket owner is closed")
}
impl SocketLease for Record {
    fn established(&self) {
        self.established.store(true, Ordering::SeqCst);
    }
    fn poll_closed(&self, cx: &mut Context<'_>, write: bool) -> Poll<()> {
        self.last_poll_ns
            .store(self.owner.now_ns(), Ordering::Relaxed);
        if write {
            self.write.register(cx.waker());
        } else {
            self.read.register(cx.waker());
        }
        if self.closing.load(Ordering::SeqCst) {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    }
}
impl Drop for Record {
    fn drop(&mut self) {
        lock(&self.owner.records).remove(&self.id);
        self.ticket.cancel();
        self.owner.drained.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    fn origin(name: &str) -> Uri {
        format!("https://{name}/").parse().unwrap()
    }
    fn peer() -> SocketAddr {
        "127.0.0.1:443".parse().unwrap()
    }
    #[tokio::test]
    async fn counts_creating_established_and_waiting_until_actual_lease_drop() {
        let pool = Connections::new(1, 1, 4, None);
        let a = pool.reserve(&origin("a.test"), peer()).await.unwrap();
        assert_eq!(pool.stats()["connections"], 1);
        assert_eq!(pool.stats()["creatingConnections"], 1);
        a.established();
        assert_eq!(pool.stats()["creatingConnections"], 0);
        let mut pending = pool.reserve(&origin("b.test"), peer());
        assert!(
            tokio::time::timeout(Duration::from_millis(5), &mut pending)
                .await
                .is_err()
        );
        assert_eq!(pool.stats()["waitingConnections"], 1);
        drop(a);
        let b = pending.await.unwrap();
        assert_eq!(pool.stats()["connections"], 1);
        pool.close();
        // Requesting close is not the same as closing an owned raw socket.
        assert_eq!(pool.stats()["connections"], 1);
        let mut cx = Context::from_waker(futures_util::task::noop_waker_ref());
        assert!(b.poll_closed(&mut cx, false).is_ready());
        assert!(b.poll_closed(&mut cx, true).is_ready());
        drop(b);
        assert!(pool.is_empty());
        assert!(pool.inner.records.lock().unwrap().is_empty());
        assert_eq!(pool.stats()["connectionOrigins"], json!([]));
    }
    #[tokio::test]
    async fn per_origin_limits_do_not_block_other_origins_and_cancelled_waiters_unlink() {
        let pool = Connections::new(2, 1, 4, None);
        let a = pool.reserve(&origin("a.test"), peer()).await.unwrap();
        let mut a2 = pool.reserve(&origin("a.test"), peer());
        assert!(
            tokio::time::timeout(Duration::from_millis(5), &mut a2)
                .await
                .is_err()
        );
        let b = pool.reserve(&origin("b.test"), peer()).await.unwrap();
        assert_eq!(pool.stats()["connections"], 2);
        assert_eq!(pool.stats()["waitingConnections"], 1);
        drop(a2);
        assert_eq!(pool.stats()["waitingConnections"], 0);
        drop((a, b));
        assert!(pool.is_empty());
    }
    #[tokio::test]
    async fn close_wakes_queued_reservations_without_resetting_live_counters() {
        let pool = Connections::new(1, 1, 4, None);
        let a = pool.reserve(&origin("a.test"), peer()).await.unwrap();
        let pending = pool.reserve(&origin("b.test"), peer());
        let stop = async {
            tokio::task::yield_now().await;
            pool.close();
        };
        let (result, ()) = tokio::join!(pending, stop);
        assert!(result.is_err());
        assert_eq!(pool.stats()["connections"], 1);
        assert_eq!(pool.stats()["waitingConnections"], 0);
        drop(a);
        assert!(pool.is_empty());
        assert!(pool.reserve(&origin("c.test"), peer()).await.is_err());
    }
    fn is_closing(lease: &Arc<dyn SocketLease>) -> bool {
        let mut cx = Context::from_waker(futures_util::task::noop_waker_ref());
        lease.poll_closed(&mut cx, false).is_ready()
    }
    #[tokio::test]
    async fn global_waiter_evicts_least_recently_used_idle_socket_of_an_unused_origin() {
        let operations = Scheduler::new(8, 8, 8);
        let pool = Connections::new(3, 3, 4, Some(operations.clone()));
        let a = pool.reserve(&origin("a.test"), peer()).await.unwrap();
        let b = pool.reserve(&origin("b.test"), peer()).await.unwrap();
        let busy = pool.reserve(&origin("busy.test"), peer()).await.unwrap();
        for lease in [&a, &b, &busy] {
            lease.established();
        }
        // b was used more recently than a; busy.test has a live operation.
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert!(!is_closing(&b));
        let _operation = operations.register(1, "https://busy.test".into()).unwrap();
        let mut c = pool.reserve(&origin("c.test"), peer());
        assert!(
            tokio::time::timeout(Duration::from_millis(5), &mut c)
                .await
                .is_err()
        );
        assert!(is_closing(&a), "LRU idle socket is evicted");
        assert!(!is_closing(&b), "one eviction per queued reservation");
        assert!(!is_closing(&busy), "sockets of busy origins are kept");
        // The observed stream drops its socket after seeing the close request.
        drop(a);
        let c = c.await.unwrap();
        assert_eq!(pool.stats()["connections"], 3);
        drop((b, busy, c));
        assert!(pool.is_empty());
    }
    #[tokio::test]
    async fn waiters_keep_retrying_eviction_and_per_origin_waits_evict_nothing() {
        let operations = Scheduler::new(8, 8, 8);
        let pool = Connections::new(2, 1, 4, Some(operations.clone()));
        let a = pool.reserve(&origin("a.test"), peer()).await.unwrap();
        let b = pool.reserve(&origin("b.test"), peer()).await.unwrap();
        a.established();
        b.established();
        // Global capacity is free for a.test, only its own per-origin cap is full.
        drop(b);
        let mut a2 = pool.reserve(&origin("a.test"), peer());
        assert!(
            tokio::time::timeout(Duration::from_millis(5), &mut a2)
                .await
                .is_err()
        );
        assert!(!is_closing(&a));
        drop(a2);
        // Both sockets serve operations, so a global waiter cannot evict yet.
        let b = pool.reserve(&origin("b.test"), peer()).await.unwrap();
        b.established();
        let op_a = operations.register(1, "https://a.test".into()).unwrap();
        let _op_b = operations.register(2, "https://b.test".into()).unwrap();
        let mut c = pool.reserve(&origin("c.test"), peer());
        assert!(
            tokio::time::timeout(Duration::from_millis(5), &mut c)
                .await
                .is_err()
        );
        assert!(!is_closing(&a) && !is_closing(&b));
        // Once a.test's operation ends, the periodic retry evicts its socket.
        drop(op_a);
        assert!(
            tokio::time::timeout(Duration::from_millis(5) + EVICTION_RETRY * 4, &mut c)
                .await
                .is_err(),
            "the waiter still needs the evicted socket to be dropped"
        );
        assert!(is_closing(&a));
        assert!(!is_closing(&b));
        drop(a);
        let c = c.await.unwrap();
        drop((b, c));
        assert!(pool.is_empty());
    }
}
