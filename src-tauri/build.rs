fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        build_touch_id();
    }
    tauri_build::build()
}

/// Touch ID quick unlock (quick_unlock.rs) is Swift: CryptoKit's Secure
/// Enclave keys have no C API. Built into a static library and linked here.
fn build_touch_id() {
    use std::process::Command;
    let src = "macos/TouchID.swift";
    println!("cargo:rerun-if-changed={src}");
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
        "aarch64" => "arm64",
        other => other,
    }
    .to_string();
    let xcrun = |args: &[&str]| -> String {
        let o = Command::new("xcrun").args(args).output().expect("xcrun (Xcode command line tools) is needed to build on macOS");
        assert!(o.status.success(), "xcrun {args:?} failed");
        String::from_utf8(o.stdout).unwrap().trim().to_string()
    };
    let sdk = xcrun(&["--sdk", "macosx", "--show-sdk-path"]);
    let swiftc = xcrun(&["--sdk", "macosx", "--find", "swiftc"]);
    let lib = out.join("libsupermarine_touchid.a");
    let status = Command::new(&swiftc)
        .args(["-parse-as-library", "-emit-library", "-static", "-O", "-module-name", "SupermarineTouchID"])
        .args(["-target", &format!("{arch}-apple-macos10.15"), "-sdk", &sdk])
        .arg("-o")
        .arg(&lib)
        .arg(src)
        .status()
        .expect("swiftc failed to start");
    assert!(status.success(), "swiftc failed on {src}");

    let toolchain_swift = std::path::Path::new(&swiftc).parent().unwrap().join("../lib/swift/macosx");
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=supermarine_touchid");
    println!("cargo:rustc-link-search=native={sdk}/usr/lib/swift");
    println!("cargo:rustc-link-search=native={}", toolchain_swift.display());
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    for fw in ["CryptoKit", "LocalAuthentication", "Security", "Foundation"] {
        println!("cargo:rustc-link-lib=framework={fw}");
    }
}
