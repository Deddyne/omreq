//! One process-wide completion channel for native promises.
//!
//! `Env::spawn_future` creates a threadsafe function per call; at tens of
//! thousands of requests per second that creation, its finalization and the
//! extra wake-up dominate the JavaScript thread. Here every promise settles
//! through a single threadsafe function: a worker queues the finished value,
//! and one wake-up of the JavaScript thread settles everything queued.
//!
//! The channel is referenced (keeps the event loop alive) only while promises
//! are pending, so an idle client does not hold the process open.
//!
//! A panic never crosses the FFI boundary: a panicking future rejects its
//! promise, and a panic while converting or dropping a value on the
//! JavaScript thread rejects (or drops) that promise instead of aborting.
use napi::{
    Env, Error, JsError, Result,
    bindgen_prelude::{PromiseRaw, ToNapiValue},
    check_status, sys,
};
use std::{
    any::Any,
    cell::Cell,
    ffi::c_void,
    future::Future,
    panic::{AssertUnwindSafe, catch_unwind},
    pin::pin,
    ptr,
    sync::{PoisonError, RwLock},
    task::Poll,
};

type Settle = Box<dyn FnOnce(sys::napi_env) -> Result<sys::napi_value> + Send>;
struct Completion {
    deferred: sys::napi_deferred,
    settle: Settle,
}
// The deferred handle is only used on the JavaScript thread, in `call_js`.
unsafe impl Send for Completion {}

/// The channel's threadsafe function; null before first use and after the
/// environment tore it down. Calls hold the read lock so teardown cannot free
/// the function underneath them.
static CHANNEL: RwLock<usize> = RwLock::new(0);
thread_local! {
    // Pending promises; JavaScript thread only.
    static PENDING: Cell<u32> = const { Cell::new(0) };
}

/// Rejection for a panic in native code. Rust panics are bugs; the message is
/// generic so no request data leaks into it.
pub(crate) fn panic_error(_panic: Box<dyn Any + Send>) -> Error {
    Error::from_reason(
        omreq_core::error::Error::new("ERR_INTERNAL", "configuration", "Native operation panicked")
            .wire(),
    )
}

unsafe extern "C" fn finalize(_env: sys::napi_env, _data: *mut c_void, _hint: *mut c_void) {
    // The lock only guards a plain integer, so a poisoned one is still valid.
    *CHANNEL.write().unwrap_or_else(PoisonError::into_inner) = 0;
}

unsafe extern "C" fn call_js(
    env: sys::napi_env,
    _callback: sys::napi_value,
    _context: *mut c_void,
    data: *mut c_void,
) {
    let completion = unsafe { Box::from_raw(data.cast::<Completion>()) };
    // Null while the environment shuts down: nothing can be settled. Dropping
    // the value runs native destructors; none of them may unwind into Node.
    if env.is_null() {
        let _ = catch_unwind(AssertUnwindSafe(move || drop(completion)));
        return;
    }
    let Completion { deferred, settle } = *completion;
    // Converting a value can run arbitrary native code (and drops the parts
    // it does not hand to JavaScript): settle a panic as a rejection.
    let result =
        catch_unwind(AssertUnwindSafe(move || settle(env))).unwrap_or_else(|p| Err(panic_error(p)));
    unsafe {
        match result {
            Ok(value) => {
                sys::napi_resolve_deferred(env, deferred, value);
            }
            Err(error) => {
                let mut pending = false;
                sys::napi_is_exception_pending(env, &mut pending);
                let mut reason = ptr::null_mut();
                if pending {
                    sys::napi_get_and_clear_last_exception(env, &mut reason);
                } else {
                    reason = JsError::from(error).into_value(env);
                }
                sys::napi_reject_deferred(env, deferred, reason);
            }
        }
        let left = PENDING.with(|p| {
            let left = p.get().saturating_sub(1);
            p.set(left);
            left
        });
        if left == 0 {
            let channel = CHANNEL.read().unwrap_or_else(PoisonError::into_inner);
            if *channel != 0 {
                sys::napi_unref_threadsafe_function(env, *channel as sys::napi_threadsafe_function);
            }
        }
    }
}

fn channel(env: sys::napi_env) -> Result<sys::napi_threadsafe_function> {
    let current = *CHANNEL
        .read()
        .map_err(|_| Error::from_reason("completion channel"))?;
    if current != 0 {
        return Ok(current as sys::napi_threadsafe_function);
    }
    let mut channel = CHANNEL
        .write()
        .map_err(|_| Error::from_reason("completion channel"))?;
    if *channel != 0 {
        return Ok(*channel as sys::napi_threadsafe_function);
    }
    unsafe {
        let mut name = ptr::null_mut();
        check_status!(sys::napi_create_string_utf8(
            env,
            c"omreq.settle".as_ptr(),
            "omreq.settle".len() as isize,
            &mut name,
        ))?;
        let mut tsfn = ptr::null_mut();
        check_status!(sys::napi_create_threadsafe_function(
            env,
            ptr::null_mut(),
            ptr::null_mut(),
            name,
            0,
            1,
            ptr::null_mut(),
            Some(finalize),
            ptr::null_mut(),
            Some(call_js),
            &mut tsfn,
        ))?;
        check_status!(sys::napi_unref_threadsafe_function(env, tsfn))?;
        *channel = tsfn as usize;
        Ok(tsfn)
    }
}

fn deliver(completion: Completion) {
    let data = Box::into_raw(Box::new(completion));
    let channel = CHANNEL.read().unwrap_or_else(PoisonError::into_inner);
    if *channel != 0 {
        let status = unsafe {
            sys::napi_call_threadsafe_function(
                *channel as sys::napi_threadsafe_function,
                data.cast(),
                sys::ThreadsafeFunctionCallMode::nonblocking,
            )
        };
        if status == sys::Status::napi_ok {
            return;
        }
    }
    drop(channel);
    // The environment is gone; the promise can never be observed.
    drop(unsafe { Box::from_raw(data) });
}

/// Runs `future` on the runtime and settles the returned promise with its
/// output through the shared channel.
pub fn spawn<'env, T, F>(env: &'env Env, future: F) -> Result<PromiseRaw<'env, T>>
where
    T: ToNapiValue + Send + 'static,
    F: Future<Output = Result<T>> + Send + 'static,
{
    let raw = env.raw();
    let tsfn = channel(raw)?;
    let mut deferred = ptr::null_mut();
    let mut promise = ptr::null_mut();
    check_status!(unsafe { sys::napi_create_promise(raw, &mut deferred, &mut promise) })?;
    let was = PENDING.with(|p| {
        let was = p.get();
        p.set(was + 1);
        was
    });
    if was == 0 {
        check_status!(unsafe { sys::napi_ref_threadsafe_function(raw, tsfn) })?;
    }
    let deferred = deferred as usize;
    napi::bindgen_prelude::spawn(async move {
        // A panicking future still settles its promise (and releases the
        // channel reference), instead of leaving it pending forever.
        let mut future = pin!(future);
        let result = std::future::poll_fn(|cx| {
            match catch_unwind(AssertUnwindSafe(|| future.as_mut().poll(cx))) {
                Ok(poll) => poll,
                Err(panic) => Poll::Ready(Err(panic_error(panic))),
            }
        })
        .await;
        deliver(Completion {
            deferred: deferred as sys::napi_deferred,
            settle: Box::new(move |env| match result {
                Ok(value) => unsafe { T::to_napi_value(env, value) },
                Err(error) => Err(error),
            }),
        });
    });
    Ok(PromiseRaw::new(raw, promise))
}
