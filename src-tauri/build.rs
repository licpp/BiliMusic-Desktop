fn main() {
    println!("cargo:rerun-if-env-changed=BILIMUSIC_BUILD_NUMBER");
    let build = std::env::var("BILIMUSIC_BUILD_NUMBER").unwrap_or_else(|_| "1".into());
    let number: u32 = build.parse().expect("Invalid BILIMUSIC_BUILD_NUMBER");
    assert!(
        (1..=50).contains(&number) && number.to_string() == build,
        "BILIMUSIC_BUILD_NUMBER must be 1–50"
    );
    println!("cargo:rustc-env=BILIMUSIC_BUILD_NUMBER={number}");
    tauri_build::build()
}
