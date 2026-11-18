use crate::error::{Error, Result};
use serde_json::{Value, json};
use std::collections::HashSet;
use wreq::http2::{
    Http2Options, PseudoId, PseudoOrder, SettingId, SettingsOrder, StreamDependency, StreamId,
};
fn invalid(message: &str) -> Error {
    Error::new("ERR_PROFILE_INVALID", "configuration", message)
}
pub fn normalize(input: &Value) -> Result<Value> {
    let settings = input.get("settings");
    let find = |name: &str| {
        settings
            .and_then(Value::as_array)
            .and_then(|a| a.iter().find(|s| s["name"] == name))
            .map(|s| s["value"].clone())
    };
    if let Some(settings) = settings.and_then(Value::as_array) {
        let mut seen = HashSet::new();
        for setting in settings {
            let name = setting["name"].as_str().expect("schema checked");
            if !seen.insert(name) {
                return Err(invalid("/transport/http2/settings: duplicate setting name"));
            }
        }
        for name in ["initialWindowSize", "maxFrameSize"] {
            if let Some(v) = input.get(name)
                && Some(v) != find(name).as_ref()
            {
                return Err(invalid(
                    "/transport/http2: option conflicts with explicit SETTINGS",
                ));
            }
        }
    }
    let window = find("initialWindowSize").or_else(|| input.get("initialWindowSize").cloned());
    if window.as_ref().and_then(Value::as_u64) == Some(0) {
        // A zero stream window lets the server send no DATA until a WINDOW_UPDATE
        // that never comes: every response body would stall until its timeout.
        return Err(invalid(
            "/transport/http2/initialWindowSize: must be greater than 0",
        ));
    }
    // Without explicit windows (a custom profile that does not imitate a
    // browser), grow them from the measured bandwidth-delay product instead of
    // capping throughput at 64 KiB per round trip. The SETTINGS frame still
    // advertises the RFC 9113 default; explicit windows are never changed.
    let adaptive = settings.is_none()
        && window.is_none()
        && input.get("initialConnectionWindowSize").is_none();
    Ok(json!({
        "initialWindowSize": window.unwrap_or(json!(65535)),
        "adaptiveWindow": adaptive,
        "initialConnectionWindowSize":input.get("initialConnectionWindowSize").cloned().unwrap_or(json!(65535)),
        "maxFrameSize":if settings.is_some() { find("maxFrameSize").unwrap_or(Value::Null) } else { input.get("maxFrameSize").cloned().unwrap_or(json!(16384)) },
        "hpackHuffman":input.get("hpackHuffman").cloned().unwrap_or(json!("always")),
        "settings":settings.cloned().unwrap_or(Value::Null),
        "pseudoHeaderOrder":input.get("pseudoHeaderOrder").cloned().unwrap_or(json!([":method",":scheme",":authority",":path"])),
        "headersPriority":input.get("headersPriority").cloned().unwrap_or(Value::Null)
    }))
}
pub fn build(input: &Value) -> Http2Options {
    let mut builder = Http2Options::builder()
        .initial_window_size(input["initialWindowSize"].as_u64().expect("normalized") as u32)
        .initial_connection_window_size(
            input["initialConnectionWindowSize"]
                .as_u64()
                .expect("normalized") as u32,
        )
        // Set after the explicit sizes, which would otherwise turn it off again.
        .adaptive_window(input["adaptiveWindow"] == true);
    if let Some(size) = input["maxFrameSize"].as_u64() {
        builder = builder.max_frame_size(size as u32);
    }
    if let Some(settings) = input["settings"].as_array() {
        let mut order = Vec::new();
        for setting in settings {
            let v = setting["value"].as_u64().expect("normalized") as u32;
            match setting["name"].as_str().expect("normalized") {
                "headerTableSize" => {
                    builder = builder.header_table_size(v);
                    order.push(SettingId::HeaderTableSize);
                }
                "enablePush" => {
                    builder = builder.enable_push(v != 0);
                    order.push(SettingId::EnablePush);
                }
                "maxConcurrentStreams" => {
                    builder = builder.max_concurrent_streams(v);
                    order.push(SettingId::MaxConcurrentStreams);
                }
                "initialWindowSize" => {
                    order.push(SettingId::InitialWindowSize);
                }
                "maxFrameSize" => {
                    order.push(SettingId::MaxFrameSize);
                }
                "maxHeaderListSize" => {
                    builder = builder.max_header_list_size(v);
                    order.push(SettingId::MaxHeaderListSize);
                }
                "enableConnectProtocol" => {
                    builder = builder.enable_connect_protocol(v != 0);
                    order.push(SettingId::EnableConnectProtocol);
                }
                "noRfc7540Priorities" => {
                    builder = builder.no_rfc7540_priorities(v != 0);
                    order.push(SettingId::NoRfc7540Priorities);
                }
                _ => unreachable!("validated setting"),
            }
        }
        builder = builder.settings_order(SettingsOrder::builder().extend(order).build());
    }
    let order = input["pseudoHeaderOrder"]
        .as_array()
        .expect("normalized")
        .iter()
        .map(|name| match name.as_str().expect("normalized") {
            ":method" => PseudoId::Method,
            ":authority" => PseudoId::Authority,
            ":scheme" => PseudoId::Scheme,
            ":path" => PseudoId::Path,
            _ => unreachable!("validated pseudo header"),
        });
    builder = builder.headers_pseudo_order(PseudoOrder::builder().extend(order).build());
    if input["headersPriority"].is_object() {
        builder = builder.headers_stream_dependency(StreamDependency::new(
            StreamId::zero(),
            (input["headersPriority"]["weight"]
                .as_u64()
                .expect("normalized")
                - 1) as u8,
            input["headersPriority"]["exclusive"]
                .as_bool()
                .expect("normalized"),
        ));
    }
    let mut options = builder.build();
    options.hpack_prefer_smaller_huffman = input["hpackHuffman"] == "smaller-only";
    options
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordered_settings_replace_defaults_without_silently_adding_frame_size() {
        let normalized=normalize(&json!({"initialConnectionWindowSize":15728640,"settings":[{"name":"headerTableSize","value":65536},{"name":"enablePush","value":0},{"name":"initialWindowSize","value":6291456},{"name":"maxHeaderListSize","value":262144}]})).unwrap();
        let options = build(&normalized);
        assert_eq!(options.initial_window_size, 6291456);
        assert_eq!(options.initial_conn_window_size, 15728640);
        assert_eq!(options.max_frame_size, None);
        assert_eq!(options.enable_push, Some(false));
        assert_eq!(options.header_table_size, Some(65536));
    }
    #[test]
    fn conflicts_and_duplicate_settings_are_errors() {
        assert!(normalize(&json!({"maxFrameSize":16384,"settings":[{"name":"initialWindowSize","value":65535}]})).is_err());
        assert!(normalize(&json!({"settings":[{"name":"initialWindowSize","value":65535},{"name":"initialWindowSize","value":1}]})).is_err());
    }
    #[test]
    fn zero_stream_window_is_rejected() {
        assert!(normalize(&json!({"initialWindowSize":0})).is_err());
        assert!(normalize(&json!({"settings":[{"name":"initialWindowSize","value":0}]})).is_err());
        assert!(normalize(&json!({"initialWindowSize":1})).is_ok());
    }
    #[test]
    fn only_profiles_without_explicit_windows_use_an_adaptive_window() {
        let options = build(&normalize(&json!({})).unwrap());
        assert!(options.adaptive_window);
        assert_eq!(options.initial_window_size, 65535);
        assert_eq!(options.initial_conn_window_size, 65535);
        assert_eq!(options.max_header_list_size, None, "SETTINGS are unchanged");
        for explicit in [
            json!({"initialWindowSize":65535}),
            json!({"initialConnectionWindowSize":1048576}),
            json!({"settings":[{"name":"initialWindowSize","value":6291456}]}),
        ] {
            assert!(!build(&normalize(&explicit).unwrap()).adaptive_window);
        }
    }
}
