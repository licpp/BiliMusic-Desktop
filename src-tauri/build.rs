fn main() {
    println!("cargo:rerun-if-env-changed=BILIMUSIC_BUILD_NUMBER");
    println!("cargo:rerun-if-env-changed=TAURI_BILIMUSIC_BUILD_NUMBER");
    let build = std::env::var("TAURI_BILIMUSIC_BUILD_NUMBER")
        .or_else(|_| std::env::var("BILIMUSIC_BUILD_NUMBER"))
        .unwrap_or_else(|_| "1".into());
    let number: u32 = build.parse().expect("Invalid BILIMUSIC_BUILD_NUMBER");
    assert!(
        (1..=50).contains(&number) && number.to_string() == build,
        "BILIMUSIC_BUILD_NUMBER must be 1–50"
    );
    println!("cargo:rustc-env=BILIMUSIC_BUILD_NUMBER={number}");
    // The app binary gets its side-by-side manifest from Tauri's resource library, but `cargo
    // test` links a bare test executable that still imports TaskDialogIndirect from comctl32 v6.
    // Without a manifest Windows binds comctl32 v5, which lacks that export, and every test dies
    // before main. Embedding a second manifest into the app binary is a duplicate resource, so
    // the test runner opts in through the environment instead of cargo's target scoping (which
    // cannot reach a lib test target).
    println!("cargo:rerun-if-env-changed=BILIMUSIC_WINDOWS_TEST_MANIFEST");
    if std::env::var_os("BILIMUSIC_WINDOWS_TEST_MANIFEST").is_some()
        && std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|os| os == "windows")
    {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("tests-windows.manifest");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    tauri_build::build()
}
