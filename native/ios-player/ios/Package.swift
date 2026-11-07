// swift-tools-version:5.3
import PackageDescription
let package = Package(
    name: "tauri-plugin-ios-player",
    platforms: [.iOS(.v15)],
    products: [.library(name: "tauri-plugin-ios-player", type: .static, targets: ["tauri-plugin-ios-player"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [.target(name: "tauri-plugin-ios-player", dependencies: [.byName(name: "Tauri")], path: "Sources",
                     linkerSettings: [.linkedFramework("AVFoundation"), .linkedFramework("MediaPlayer"), .linkedFramework("Security")])]
)
