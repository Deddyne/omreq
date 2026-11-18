//! Optional native TCP lifetime hooks. No hook is installed by default.
use crate::conn::{Connected, Connection, TlsInfoFactory};
use std::{
    error::Error as StdError,
    fmt,
    future::Future,
    io,
    net::SocketAddr,
    ops::Deref,
    pin::Pin,
    sync::{Arc, Mutex, PoisonError},
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// A reservation acquired before creating the TCP socket of one logical
/// connect. Happy Eyeballs candidates of that connect share it (see
/// `ReservationGroup`): `peer` is the first candidate's address. The future
/// must release any queued reservation when dropped. Logical origin remains
/// the target even through a proxy.
pub trait SocketObserver: Send + Sync + 'static {
    /// Reserve capacity for a physical socket to `peer` on behalf of `origin`.
    fn reserve(&self, origin: &http::Uri, peer: SocketAddr) -> SocketReservation;
}
/// Pending physical socket reservation.
pub type SocketReservation = Pin<
    Box<
        dyn Future<Output = Result<Arc<dyn SocketLease>, Box<dyn std::error::Error + Send + Sync>>>
            + Send,
    >,
>;
/// Native reservation owned until the socket is dropped. Response extensions
/// and connection pool metadata never own this reservation.
pub trait SocketLease: Send + Sync + 'static {
    /// TCP has connected; TLS negotiation may still be pending.
    fn established(&self);
    /// Register the current read/connect or write waker, and return Ready when
    /// the owner requests socket closure. Implementations must avoid lost wakes.
    fn poll_closed(&self, cx: &mut Context<'_>, write: bool) -> Poll<()>;
}

type SharedError = Arc<dyn StdError + Send + Sync>;
/// One reservation shared by every address candidate of one logical connect.
///
/// Happy Eyeballs races several sockets for one connection. Reserving capacity
/// per candidate lets a hung first candidate hold the only free slot while the
/// fallback candidate of the same connect queues behind it until the connect
/// timeout. Instead the first candidate reserves, later candidates (parallel or
/// sequential) wait for and share that reservation, a bounded overcommit of at
/// most the parallel-attempt limit, and the winning socket keeps it. Dropping
/// the group with the connect cancels a pending reservation or releases an
/// unused one once the losing candidates are gone.
#[derive(Default)]
pub(crate) struct ReservationGroup {
    state: Mutex<GroupState>,
}
#[derive(Default)]
enum GroupState {
    #[default]
    Empty,
    Pending(SocketReservation),
    Ready(Result<Arc<dyn SocketLease>, SharedError>),
}
impl ReservationGroup {
    /// Reserves for the first caller; later callers share the outcome. All
    /// candidates of a connect are polled by the same task, so the waker the
    /// pending reservation keeps always wakes the remaining candidates.
    pub(crate) async fn reserve(
        &self,
        observer: &dyn SocketObserver,
        origin: &http::Uri,
        peer: SocketAddr,
    ) -> Result<Arc<dyn SocketLease>, Box<dyn StdError + Send + Sync>> {
        std::future::poll_fn(|cx| {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            if matches!(*state, GroupState::Empty) {
                *state = GroupState::Pending(observer.reserve(origin, peer));
            }
            if let GroupState::Pending(future) = &mut *state {
                match future.as_mut().poll(cx) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(result) => *state = GroupState::Ready(result.map_err(Arc::from)),
                }
            }
            match &*state {
                GroupState::Ready(Ok(lease)) => Poll::Ready(Ok(lease.clone())),
                GroupState::Ready(Err(error)) => {
                    Poll::Ready(Err(Box::new(SharedReservationError(error.clone())) as _))
                }
                _ => unreachable!("reservation group polled to completion"),
            }
        })
        .await
    }
}
/// A reservation failure reported to every candidate that shared it.
#[derive(Debug)]
struct SharedReservationError(SharedError);
impl fmt::Display for SharedReservationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, f)
    }
}
impl StdError for SharedReservationError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        Some(&*self.0)
    }
}

std::thread_local! {
    static RACED_CONNECT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
/// Whether the code being polled is a connect that lost the pool race to an
/// idle connection. Such a connect is completed in the background so its
/// socket reaches the pool, but a `SocketObserver` should refuse to queue its
/// reservation: no request is waiting for that socket.
pub fn is_raced_connect() -> bool {
    RACED_CONNECT.with(std::cell::Cell::get)
}
/// Poll `connect` with [`is_raced_connect`] reporting true.
pub(crate) fn raced_connect(
    connect: impl Future<Output = ()> + Send + 'static,
) -> impl Future<Output = ()> + Send + 'static {
    struct Raced(Pin<Box<dyn Future<Output = ()> + Send>>);
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            RACED_CONNECT.with(|flag| flag.set(self.0));
        }
    }
    impl Future for Raced {
        type Output = ();
        fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
            let _restore = Restore(RACED_CONNECT.with(|flag| flag.replace(true)));
            self.0.as_mut().poll(cx)
        }
    }
    Raced(Box::pin(connect))
}

// Field order is intentional: close the stream/FD before releasing capacity.
#[doc(hidden)]
pub struct Observed<T> {
    pub(crate) inner: T,
    pub(crate) lease: Option<Arc<dyn SocketLease>>,
}
impl<T: fmt::Debug> fmt::Debug for Observed<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("Observed").field(&self.inner).finish()
    }
}
impl<T> Deref for Observed<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.inner
    }
}
impl<T: Connection> Connection for Observed<T> {
    fn connected(&self) -> Connected {
        self.inner.connected()
    }
}
impl<T: TlsInfoFactory> TlsInfoFactory for Observed<T> {
    fn tls_info(&self) -> Option<crate::tls::TlsInfo> {
        self.inner.tls_info()
    }
}
impl<T> Observed<T> {
    fn check(&self, cx: &mut Context<'_>, write: bool) -> io::Result<()> {
        if self
            .lease
            .as_ref()
            .is_some_and(|l| l.poll_closed(cx, write).is_ready())
        {
            Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "TCP owner closed",
            ))
        } else {
            Ok(())
        }
    }
}
impl<T: AsyncRead + Unpin> AsyncRead for Observed<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        self.check(cx, false)?;
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}
impl<T: AsyncWrite + Unpin> AsyncWrite for Observed<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.check(cx, true)?;
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }
    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        self.check(cx, true)?;
        Pin::new(&mut self.inner).poll_write_vectored(cx, bufs)
    }
    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.check(cx, true)?;
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.check(cx, true)?;
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    struct Inner(Arc<AtomicBool>);
    impl Drop for Inner {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    struct Lease(Arc<AtomicBool>);
    impl SocketLease for Lease {
        fn established(&self) {}
        fn poll_closed(&self, _: &mut Context<'_>, _: bool) -> Poll<()> {
            Poll::Pending
        }
    }
    impl Drop for Lease {
        fn drop(&mut self) {
            assert!(
                self.0.load(Ordering::SeqCst),
                "Capacity returned before raw socket drop"
            );
        }
    }
    struct Counting {
        reservations: Arc<std::sync::atomic::AtomicUsize>,
        released: Arc<AtomicBool>,
    }
    struct Released(Arc<AtomicBool>);
    impl SocketLease for Released {
        fn established(&self) {}
        fn poll_closed(&self, _: &mut Context<'_>, _: bool) -> Poll<()> {
            Poll::Pending
        }
    }
    impl Drop for Released {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    impl SocketObserver for Counting {
        fn reserve(&self, _: &http::Uri, _: SocketAddr) -> SocketReservation {
            self.reservations.fetch_add(1, Ordering::SeqCst);
            let lease = Arc::new(Released(self.released.clone())) as Arc<dyn SocketLease>;
            Box::pin(async move {
                tokio::task::yield_now().await;
                Ok(lease)
            })
        }
    }
    #[tokio::test]
    async fn candidates_of_one_connect_share_one_reservation() {
        let observer = Counting {
            reservations: Default::default(),
            released: Default::default(),
        };
        let origin: http::Uri = "https://example.test/".parse().unwrap();
        let group = ReservationGroup::default();
        let first = group.reserve(&observer, &origin, "[::1]:443".parse().unwrap());
        let second = group.reserve(&observer, &origin, "127.0.0.1:443".parse().unwrap());
        let (first, second) = tokio::join!(first, second);
        let (first, second) = (first.unwrap(), second.unwrap());
        assert!(Arc::ptr_eq(&first, &second));
        let third = group
            .reserve(&observer, &origin, "127.0.0.2:443".parse().unwrap())
            .await
            .unwrap();
        assert_eq!(observer.reservations.load(Ordering::SeqCst), 1);
        drop((first, second, group));
        assert!(!observer.released.load(Ordering::SeqCst), "the winner keeps it");
        drop(third);
        assert!(observer.released.load(Ordering::SeqCst));
    }
    #[test]
    fn stream_is_dropped_before_its_reservation() {
        let closed = Arc::new(AtomicBool::new(false));
        drop(Observed {
            inner: Inner(closed.clone()),
            lease: Some(Arc::new(Lease(closed.clone()))),
        });
        assert!(closed.load(Ordering::SeqCst));
    }
}
