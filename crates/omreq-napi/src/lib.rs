use napi::{
    Env, Error, Result,
    bindgen_prelude::{Buffer, PromiseRaw, ToNapiValue},
    check_status, sys,
};
use napi_derive::napi;
use omreq_core::{
    client::{CoreClient, Operation},
    profile::{BUILD_ID, CAPABILITIES, Profile},
};
use std::{
    mem::ManuallyDrop,
    ops::Deref,
    panic::{AssertUnwindSafe, catch_unwind},
    sync::Arc,
};
mod settle;
/// Native state owned by a JavaScript object. It is dropped by the garbage
/// collector's finalizer, an `extern "C"` callback: a panic in a destructor
/// there would abort the process, so it is contained (the value may leak).
struct Guarded<T>(ManuallyDrop<T>);
impl<T> Guarded<T> {
    fn new(value: T) -> Self {
        Self(ManuallyDrop::new(value))
    }
}
impl<T> Deref for Guarded<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.0
    }
}
impl<T> Drop for Guarded<T> {
    fn drop(&mut self) {
        // SAFETY: dropped exactly once, here; never used afterwards.
        let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
            ManuallyDrop::drop(&mut self.0)
        }));
    }
}
/// Requests cross from the JavaScript thread into this runtime one task at a
/// time. A few workers keep that hand-off (and the admission/socket locks the
/// workers share) uncontended; the transport work per request is small.
/// `OMREQ_WORKER_THREADS` overrides the count.
#[napi_derive::module_init]
fn init() {
    let workers = std::env::var("OMREQ_WORKER_THREADS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|n| (1..=64).contains(n))
        .unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map_or(2, |n| n.get())
                .clamp(1, DEFAULT_WORKERS)
        });
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(workers)
        .thread_name("omreq-worker")
        .enable_all()
        .build()
        .expect("omreq tokio runtime");
    napi::bindgen_prelude::create_custom_tokio_runtime(runtime);
}
const DEFAULT_WORKERS: usize = 2;
fn err(e: omreq_core::error::Error) -> Error {
    Error::from_reason(e.wire())
}
fn input_err() -> Error {
    err(omreq_core::error::Error::new(
        "ERR_INVALID_ARGUMENT",
        "configuration",
        "Invalid native wire configuration",
    ))
}
#[napi(catch_unwind)]
pub fn build_info() -> String {
    serde_json::json!({"version":env!("CARGO_PKG_VERSION"), "bridgeAbi":serde_json::from_str::<serde_json::Value>(include_str!("../../../bridge.json")).expect("bundled bridge version")["abi"],"nodeApi":8,"engineBuildId":BUILD_ID,"capabilities":CAPABILITIES,"transport":"wreq/0.16.5", "tls":"btls/0.5.6+3c1dd080ba617d78c63cd09285d2ce31abcdcbf9", "boringSslRevision":"427ec40cc8edc545253289232e885708c409e5ea", "bundledTrustStores":["webpki-root-certs/1.0.12","chromium-roots/0.1.3"], "cookiePslVersion":omreq_core::COOKIE_PSL_VERSION,"stage":"internal-prototype"}).to_string()
}
#[napi(catch_unwind)]
pub fn check_profile(text: String) -> Result<String> {
    let profile = Profile::parse(&text).map_err(err)?;
    let mut report = profile.report();
    if report["compatible"] == true {
        let validation = CoreClient::new(
            &profile,
            omreq_core::client::ClientConfig {
                max_active_operations: 1,
                max_queued_operations: 0,
                max_active_per_origin: 1,
                max_connections: 64,
                max_connections_per_origin: 8,
                max_aggregate_buffered_response_bytes: 134217728,
                connect_ms: 1000,
                ca: None,
                trust_store: None,
                cookies: true,
                proxies: Vec::new(),
                resolve: Default::default(),
                http3: true,
            },
        );
        if validation.is_err() {
            report["compatible"] = serde_json::json!(false);
            report["issues"] = serde_json::json!([{"code":"ERR_PROFILE_UNSUPPORTED","path":"/transport/tls","message":"The native TLS backend rejected the profile configuration"}]);
        }
    }
    Ok(report.to_string())
}
/// Compatibility report of a profile without building a transport. Client
/// construction itself reports a TLS backend rejection.
#[napi(catch_unwind)]
pub fn profile_report(text: String) -> Result<String> {
    Ok(Profile::parse(&text).map_err(err)?.report().to_string())
}
/// Settled value of `NativeClient.request`:
/// `[status, httpVersion, url, headers, redirects, body, cleaned, operation]`.
/// - `url` is set only when the final URL differs from the requested one.
/// - `headers` is `name\0value\0...` (values are Latin-1 byte strings; NUL
///   cannot occur in a header field), parsed lazily in JavaScript.
/// - `redirects` is the JSON redirect history, set only after redirects.
/// - `body` is a copy of the whole body when it arrived with the headers; the
///   operation has then finished and `cleaned` says whether its native
///   resources are released too. Otherwise `operation` streams the body.
pub struct Started {
    status: u16,
    version: &'static str,
    url: Option<String>,
    headers: String,
    redirects: Option<String>,
    body: Option<Vec<u8>>,
    cleaned: bool,
    operation: Option<Arc<Operation>>,
}
impl Started {
    fn new(
        requested: &str,
        executed: omreq_core::client::Executed,
        operation: Arc<Operation>,
    ) -> Self {
        let meta = executed.meta;
        let mut headers = String::with_capacity(
            meta.headers
                .iter()
                .map(|(k, v)| k.len() + v.len() + 2)
                .sum(),
        );
        for (name, value) in &meta.headers {
            headers.push_str(name);
            headers.push('\0');
            headers.push_str(value);
            headers.push('\0');
        }
        let redirects = (!meta.redirects.is_empty())
            .then(|| serde_json::to_string(&meta.redirects).expect("redirect history"));
        let cleaned = operation.is_cleaned();
        Self {
            status: meta.status,
            version: match meta.http_version.as_str() {
                "3" => "3",
                "2" => "2",
                "1.0" => "1.0",
                _ => "1.1",
            },
            url: (meta.url != requested).then_some(meta.url),
            headers,
            redirects,
            // A finished operation is released here, on a worker thread, not
            // when the JavaScript thread converts the result.
            operation: executed.body.is_none().then_some(operation),
            body: executed.body,
            cleaned,
        }
    }
}
unsafe fn set(
    env: sys::napi_env,
    array: sys::napi_value,
    index: u32,
    value: sys::napi_value,
) -> Result<()> {
    check_status!(unsafe { sys::napi_set_element(env, array, index, value) })
}
impl ToNapiValue for Started {
    unsafe fn to_napi_value(env: sys::napi_env, value: Self) -> Result<sys::napi_value> {
        unsafe {
            let mut array = std::ptr::null_mut();
            check_status!(sys::napi_create_array_with_length(env, 8, &mut array))?;
            set(
                env,
                array,
                0,
                u32::to_napi_value(env, u32::from(value.status))?,
            )?;
            set(env, array, 1, <&str>::to_napi_value(env, value.version)?)?;
            if let Some(url) = value.url {
                set(env, array, 2, String::to_napi_value(env, url)?)?;
            }
            set(env, array, 3, String::to_napi_value(env, value.headers)?)?;
            if let Some(redirects) = value.redirects {
                set(env, array, 4, String::to_napi_value(env, redirects)?)?;
            }
            if let Some(body) = value.body {
                // Small bodies are copied into a V8-owned buffer: cheaper than an
                // external buffer with a finalizer.
                let mut data = std::ptr::null_mut();
                let mut buffer = std::ptr::null_mut();
                check_status!(sys::napi_create_buffer_copy(
                    env,
                    body.len(),
                    body.as_ptr().cast(),
                    &mut data,
                    &mut buffer,
                ))?;
                set(env, array, 5, buffer)?;
            }
            set(env, array, 6, bool::to_napi_value(env, value.cleaned)?)?;
            if let Some(core) = value.operation {
                set(
                    env,
                    array,
                    7,
                    NativeOperation::to_napi_value(
                        env,
                        NativeOperation {
                            core: Guarded::new(core),
                        },
                    )?,
                )?;
            }
            Ok(array)
        }
    }
}
fn wire_config(config: &str) -> omreq_core::error::Result<omreq_core::client::RequestConfig> {
    serde_json::from_str(config).map_err(|_| {
        omreq_core::error::Error::new(
            "ERR_INVALID_ARGUMENT",
            "configuration",
            "Invalid native wire configuration",
        )
    })
}
fn wire_id(id: f64) -> Result<u64> {
    if !id.is_finite() || id.fract() != 0.0 || !(1.0..=9007199254740991.0).contains(&id) {
        return Err(input_err());
    }
    Ok(id as u64)
}
#[napi]
pub struct NativeClient {
    core: Guarded<CoreClient>,
}
#[napi]
impl NativeClient {
    #[napi(constructor, catch_unwind)]
    pub fn new(profile: String, config: String) -> Result<Self> {
        let profile = Profile::parse(&profile).map_err(err)?;
        let config = serde_json::from_str(&config).map_err(|_| input_err())?;
        Ok(Self {
            core: Guarded::new(CoreClient::new(&profile, config).map_err(err)?),
        })
    }
    /// Opens operation `id` (admission order is the call order) and starts it.
    #[napi(catch_unwind)]
    pub fn request<'env>(
        &self,
        env: &'env Env,
        id: f64,
        url: String,
        config: String,
        body: Option<Buffer>,
    ) -> Result<PromiseRaw<'env, Started>> {
        let operation = self.core.open_with_id(wire_id(id)?, &url).map_err(err)?;
        settle::spawn(env, async move {
            let executed = operation
                .execute_prepared(move || Ok((wire_config(&config)?, body.map(|b| b.to_vec()))))
                .await
                .map_err(err)?;
            Ok(Started::new(&url, executed, operation))
        })
    }
    /// Handle of a live operation, or null once it has been cleaned up.
    #[napi(catch_unwind)]
    pub fn operation(&self, id: f64) -> Result<Option<NativeOperation>> {
        Ok(self
            .core
            .operation(wire_id(id)?)
            .map(|core| NativeOperation {
                core: Guarded::new(core),
            }))
    }
    #[napi(catch_unwind)]
    pub fn cancel(&self, id: f64, code: String) -> Result<()> {
        if let Some(operation) = self.core.operation(wire_id(id)?) {
            operation.cancel(&code);
        }
        Ok(())
    }
    /// Resolves once operation `id` has released all native resources.
    #[napi]
    pub async fn wait_cleanup(&self, id: f64) -> Result<()> {
        if let Some(operation) = self.core.operation(wire_id(id)?) {
            operation.wait_cleanup().await;
        }
        Ok(())
    }
    #[napi(catch_unwind)]
    pub fn stats(&self) -> String {
        self.core.stats().to_string()
    }
    #[napi(catch_unwind)]
    pub fn set_cookie(&self, value: String, url: String) -> Result<()> {
        self.core.set_cookie(&value, &url).map_err(err)
    }
    #[napi(catch_unwind)]
    pub fn get_cookies(&self, url: String) -> Result<String> {
        self.core
            .get_cookies(&url)
            .map(|v| v.to_string())
            .map_err(err)
    }
    #[napi(catch_unwind)]
    pub fn clear_cookies(&self) -> Result<()> {
        self.core.clear_cookies().map_err(err)
    }
    #[napi(catch_unwind)]
    pub fn buffer_budget(&self) -> Result<NativeBufferBudget> {
        Ok(NativeBufferBudget {
            core: Guarded::new(self.core.buffer_budget().map_err(err)?),
        })
    }
    #[napi]
    pub async fn close(&self) -> Result<()> {
        self.core.close().await.map_err(err)
    }
}
#[napi]
pub struct NativeBufferBudget {
    core: Guarded<omreq_core::budget::BufferBudget>,
}
#[napi]
impl NativeBufferBudget {
    #[napi(catch_unwind)]
    pub fn reserve(&self, amount: f64) -> Result<()> {
        if !amount.is_finite() || amount.fract() != 0.0 || !(0.0..=2147483647.0).contains(&amount) {
            return Err(input_err());
        }
        self.core.reserve(amount as usize).map_err(err)
    }
    #[napi(catch_unwind)]
    pub fn release(&self) {
        self.core.release();
    }
}
#[napi]
pub struct NativeOperation {
    core: Guarded<Arc<Operation>>,
}
#[napi]
impl NativeOperation {
    #[napi(getter, catch_unwind)]
    pub fn id(&self) -> f64 {
        self.core.id as f64
    }
    #[napi(catch_unwind)]
    pub fn cleaned(&self) -> bool {
        self.core.is_cleaned()
    }
    #[napi]
    pub async fn read_all(&self, max: f64) -> Result<Buffer> {
        if !max.is_finite() || max.fract() != 0.0 || !(0.0..=9007199254740991.0).contains(&max) {
            return Err(input_err());
        }
        self.core
            .read_all(max.min(usize::MAX as f64) as usize)
            .await
            .map(Buffer::from)
            .map_err(err)
    }
    #[napi]
    pub async fn wait_terminal(&self) -> Option<String> {
        self.core.wait_terminal().await
    }
    #[napi]
    pub async fn wait_cleanup(&self) {
        self.core.wait_cleanup().await;
    }
    #[napi]
    pub async fn wait_upload_stopped(&self) {
        self.core.wait_upload_stopped().await;
    }
    #[napi]
    pub async fn wait_upload_epoch_ended(&self, epoch: u32) {
        self.core.wait_upload_epoch_ended(epoch).await;
    }
    #[napi]
    pub async fn read(&self) -> Result<Option<Buffer>> {
        self.core
            .read()
            .await
            .map(|v| v.map(Buffer::from))
            .map_err(err)
    }
    #[napi]
    pub async fn upload_demand(&self) -> Result<u32> {
        self.core.upload_demand().await.map_err(err)
    }
    #[napi(catch_unwind)]
    pub fn upload_fail(&self, epoch: u32, code: String) -> bool {
        self.core.upload_fail(epoch, &code)
    }
    /// The chunk is copied here, on the JavaScript thread, so no JavaScript
    /// buffer reference outlives this call; the write then runs natively.
    #[napi(catch_unwind)]
    pub fn upload_write<'env>(
        &self,
        env: &'env Env,
        epoch: u32,
        chunk: Option<Buffer>,
        source_error: bool,
    ) -> Result<PromiseRaw<'env, bool>> {
        let chunk = chunk.map(|b| b.to_vec());
        let core = Arc::clone(&self.core);
        settle::spawn(env, async move {
            core.upload_write(epoch, chunk, source_error)
                .await
                .map_err(err)
        })
    }
    /// Why a streaming upload stopped early (JSON wire error), or null.
    #[napi(catch_unwind)]
    pub fn upload_error(&self) -> Option<String> {
        self.core.upload_error()
    }
    #[napi(catch_unwind)]
    pub fn cancel(&self, code: String) {
        self.core.cancel(&code);
    }
}
