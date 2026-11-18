use sha2::{Digest, Sha256};
use std::{env, fs, path::Path};
fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut files = vec![
        "Cargo.lock".to_string(),
        "bridge.json".into(),
        "patches/transport.json".into(),
        "patches/vendor-manifest.json".into(),
        "patches/cookies.json".into(),
        "vendor/wreq/Cargo.toml".into(),
        "Cargo.toml".into(),
        "rust-toolchain.toml".into(),
        "profiles/profile-v1.schema.json".into(),
        "crates/omreq-core/Cargo.toml".into(),
        "crates/omreq-core/build.rs".into(),
        "crates/omreq-napi/Cargo.toml".into(),
        "crates/omreq-napi/src/lib.rs".into(),
    ];
    /// Source files below `relative`, recursively. Dotfiles (`.DS_Store`,
    /// editor swap files) and dot-directories are not build inputs; `only_rs`
    /// further limits the walk to Rust sources.
    fn collect(root: &Path, relative: &str, only_rs: bool, files: &mut Vec<String>) {
        for entry in fs::read_dir(root.join(relative)).expect("source directory") {
            let entry = entry.expect("source file");
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') {
                continue;
            }
            let path = format!("{relative}/{name}");
            if entry.file_type().expect("source type").is_dir() {
                collect(root, &path, only_rs, files);
            } else if !only_rs || name.ends_with(".rs") {
                files.push(path);
            }
        }
    }
    collect(&root, "crates/omreq-core/src", true, &mut files);
    for package in ["wreq", "wreq-proto", "http2"] {
        files.push(format!("vendor/{package}/Cargo.toml"));
        collect(&root, &format!("vendor/{package}/src"), false, &mut files);
    }
    files.sort();
    let mut hash = Sha256::new();
    for file in files {
        println!("cargo:rerun-if-changed={}", root.join(&file).display());
        hash.update(file.as_bytes());
        hash.update([0]);
        hash.update(fs::read(root.join(file)).expect("build input"));
        hash.update([0]);
    }
    hash.update(env::var("TARGET").expect("target").as_bytes());
    println!(
        "cargo:rustc-env=OMREQ_ENGINE_BUILD_ID=omreq-engine-sha256:{:x}",
        hash.finalize()
    );
}
