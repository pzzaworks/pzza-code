fn main() {
    tauri_build::build();

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // The speech engine's Metal availability checks need Apple's compiler
        // runtime, which Rust's native linker invocation does not add itself.
        let output = std::process::Command::new("xcrun")
            .args(["clang", "--print-runtime-dir"])
            .output()
            .expect("Could not locate the Apple compiler runtime");
        assert!(
            output.status.success(),
            "Apple compiler runtime lookup failed"
        );
        let directory = String::from_utf8(output.stdout)
            .expect("Apple compiler runtime path is not valid UTF-8");
        let runtime = std::path::Path::new(directory.trim()).join("libclang_rt.osx.a");
        assert!(
            runtime.is_file(),
            "Apple compiler runtime archive is missing"
        );
        println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");
        println!("cargo:rerun-if-changed={}", runtime.display());
        println!("cargo:rustc-link-arg={}", runtime.display());
    }
}
