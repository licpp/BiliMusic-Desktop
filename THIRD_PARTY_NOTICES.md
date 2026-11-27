# Third-party notices

This project depends on third-party Rust crates and npm packages. Their respective licenses remain in effect and are not replaced by the project's MIT license.

Public releases include machine-readable dependency notices with dependency versions, declared licenses, and available license text, alongside `LICENSE`, this notice, and a SHA-256 file list. The first public 0.1.4 release uses a combined `THIRD_PARTY_LICENSES.json`. Starting with 0.1.5, release CI generates `release-notices-macOS.json` and `release-notices-Windows.json` from each platform build using `scripts/release-notices.mjs`. Additional recommended checks:

- Rust: `cargo deny check licenses`
- npm: an SPDX-compatible license report generated from the lockfile

The project does not bundle media, lyrics, comments, danmaku, or branding from Bilibili or any metadata provider, with one exception: `public/netease-music.png` is the NetEase Cloud Music application icon, used only to identify that recommendation source in the provider picker. It remains the trademark of its owner and implies no affiliation or endorsement. Availability of a provider adapter does not imply affiliation or authorization by that provider.

Runtime services used by the current implementation:

- Bilibili: search, playback sources, account QR login, comments and danmaku. Requests originate from the native provider and are subject to platform availability and account permissions.
- LRCLIB: lyric search and lyric candidates.
- NetEase Cloud Music: album/artwork candidates and lyric search, including translation and romanization where supplied; optional QR-code login for the daily-recommendation source and reading its daily recommendation list. Catalog and lyric requests use a separate cookie-free client. Recommendation credentials (`MUSIC_U` and CSRF) are stored only in the device-local recommendation database, are never uploaded or synced, and no audio is obtained from NetEase. The daily-recommendation endpoint is not a documented public API for third-party clients; availability and account risk are described in `docs/DAILY_RECOMMENDATION.md`.
- QQ Music: album/artwork candidates and lyric search, including translation and romanization where supplied. Requests use a separate cookie-free client; no audio is obtained from this provider.
- Apple iTunes Search API: album and artwork candidates. Catalog results are not bundled with the application.

Principal UI/runtime dependencies include React (MIT), Zustand (MIT), TanStack Query (MIT), Lucide (ISC), qrcode.react (ISC), and Tauri (MIT OR Apache-2.0). Consult the installed package/crate notices and lockfiles for exact versions and the full dependency graph.

The QRC decoding module at `src-tauri/src/infrastructure/providers/qrc_codec.rs` is adapted from [J0R6IT0/navidrome-lyrics-plugin](https://github.com/J0R6IT0/navidrome-lyrics-plugin/blob/4b78b89bd53ddf78dfb15769379347a37cd23e92/src/providers/qqmusic/qrc.rs), commit `4b78b89bd53ddf78dfb15769379347a37cd23e92`, under the MIT License, Copyright (c) 2026 Jorge Pardo. The complete permission and warranty notice is retained in the source file and in `licenses/qrc-codec-MIT.txt`. BiliMusic retains only the decoder and adds size bounds. Base64 decoding uses the `base64` crate (MIT OR Apache-2.0).

Desktop system media controls use [souvlaki](https://github.com/Sinono3/souvlaki), distributed under the MIT license.

Android system media controls use [AndroidX Media3](https://github.com/androidx/media), distributed under the Apache License 2.0.

## Experimental Harmony build tooling

The source overlay and SDK compiler setup in `scripts/ohos.py` are adapted from [LeenHawk/tauri-harmony](https://github.com/LeenHawk/tauri-harmony), copyright (c) 2026 LeenHawk, under the MIT License. The complete license is in `licenses/tauri-harmony-MIT.txt`. Experimental runtime revisions are pinned in `platforms/ohos/toolchain-pins.json`; fetched sources retain their upstream licenses.
