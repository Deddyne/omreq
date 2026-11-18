//! Credits for library-owned full-response buffers, including concatenation.
//! Leases outlive operation cancellation until the JS collector drops its bytes.
use crate::error::{Error, Result, lock};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

pub(crate) struct BytePool {
    limit: usize,
    used: AtomicUsize,
    drained: tokio::sync::Notify,
}
#[derive(Default)]
struct Reservation {
    held: usize,
    closed: bool,
}
pub struct BufferBudget {
    pool: Arc<BytePool>,
    reservation: Mutex<Reservation>,
}
impl BytePool {
    pub fn new(limit: usize) -> Arc<Self> {
        Arc::new(Self {
            limit,
            used: AtomicUsize::new(0),
            drained: tokio::sync::Notify::new(),
        })
    }
    /// Resolves after a release that may have emptied the pool.
    pub fn drained(&self) -> tokio::sync::futures::Notified<'_> {
        self.drained.notified()
    }
    pub fn used(&self) -> usize {
        self.used.load(Ordering::SeqCst)
    }
    pub fn lease(self: &Arc<Self>) -> BufferBudget {
        BufferBudget {
            pool: self.clone(),
            reservation: Mutex::new(Reservation::default()),
        }
    }
}
impl BufferBudget {
    pub fn reserve(&self, amount: usize) -> Result<()> {
        let mut reservation = lock(&self.reservation);
        if reservation.closed {
            return Err(Error::new(
                "ERR_BODY_DISPOSED",
                "body",
                "Buffered collection is closed",
            ));
        }
        let mut used = self.pool.used();
        loop {
            let Some(next) = used.checked_add(amount).filter(|n| *n <= self.pool.limit) else {
                return Err(Error::new(
                    "ERR_RESOURCE_LIMIT",
                    "body",
                    "Aggregate buffered response byte budget exceeded",
                ));
            };
            match self.pool.used.compare_exchange_weak(
                used,
                next,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => {
                    reservation.held += amount;
                    return Ok(());
                }
                Err(current) => used = current,
            }
        }
    }
    pub fn release(&self) {
        let mut reservation = lock(&self.reservation);
        if reservation.closed {
            return;
        }
        reservation.closed = true;
        self.pool
            .used
            .fetch_sub(std::mem::take(&mut reservation.held), Ordering::SeqCst);
        self.pool.drained.notify_waiters();
    }
}
impl Drop for BufferBudget {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn leases_compete_and_release_is_idempotent() {
        let pool = BytePool::new(100);
        let a = pool.lease();
        let b = pool.lease();
        a.reserve(60).unwrap();
        assert_eq!(b.reserve(41).unwrap_err().code, "ERR_RESOURCE_LIMIT");
        b.reserve(40).unwrap();
        assert_eq!(pool.used(), 100);
        a.release();
        a.release();
        assert_eq!(pool.used(), 40);
        assert_eq!(a.reserve(1).unwrap_err().code, "ERR_BODY_DISPOSED");
        drop((a, b));
        assert_eq!(pool.used(), 0);
    }
    #[test]
    fn overflow_and_zero_are_bounded() {
        let pool = BytePool::new(100);
        let a = pool.lease();
        a.reserve(0).unwrap();
        a.reserve(1).unwrap();
        assert!(a.reserve(usize::MAX).is_err());
        assert_eq!(pool.used(), 1);
        drop(a);
        assert_eq!(pool.used(), 0);
    }
    #[test]
    fn concurrent_reservations_never_exceed_the_shared_limit() {
        let pool = BytePool::new(1024);
        let barrier = Arc::new(std::sync::Barrier::new(16));
        std::thread::scope(|scope| {
            for _ in 0..16 {
                let pool = pool.clone();
                let barrier = barrier.clone();
                scope.spawn(move || {
                    for _ in 0..50 {
                        let lease = pool.lease();
                        let granted = lease.reserve(128).is_ok();
                        barrier.wait();
                        assert!(pool.used() <= 1024);
                        if granted {
                            assert!(pool.used() >= 128);
                        }
                        barrier.wait();
                        drop(lease);
                        barrier.wait();
                    }
                });
            }
        });
        assert_eq!(pool.used(), 0);
    }
}
