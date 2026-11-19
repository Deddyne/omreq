mod admission;
pub mod budget;
pub mod client;
mod connections;
mod cookies;
pub const COOKIE_PSL_VERSION: &str = cookies::PSL_VERSION;
pub mod error;
mod h3;
pub mod profile;
// These pins constrain upstream's otherwise floating qualification graph.
use btls as _;
use btls_sys as _;
use wreq_proto as _;
use wreq_rt as _;

mod profile_headers;
mod profile_http2;
mod profile_tls;
mod redirect;
