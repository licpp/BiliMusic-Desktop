# Third-party notices

This project depends on third-party Rust crates and npm packages. Their respective licenses remain in effect and are not replaced by the project's MIT license.

Public releases include machine-readable dependency notices with dependency versions, declared licenses, and available license text, alongside `LICENSE`, this notice, and a SHA-256 file list. The first public 0.1.4 release uses a combined `THIRD_PARTY_LICENSES.json`. Starting with 0.1.5, release CI generates `release-notices-macOS.json` and `release-notices-Windows.json` from each platform build using `scripts/release-notices.mjs`. Additional recommended checks:

- Rust: `cargo deny check licenses`
- npm: an SPDX-compatible license report generated from the lockfile

The project does not bundle media, lyrics, comments, danmaku, or branding from Bilibili or any metadata provider. Availability of a provider adapter does not imply affiliation or authorization by that provider.

Runtime services used by the current implementation:

- Bilibili: search, playback sources, account QR login, comments and danmaku. Requests originate from the native provider and are subject to platform availability and account permissions.
- LRCLIB: lyric search and lyric candidates.
- NetEase Cloud Music and QQ Music: album/artwork candidates and lyric search, including translation and romanization where supplied. Requests use a separate cookie-free client; no audio is obtained from these providers.
- Apple iTunes Search API: album and artwork candidates. Catalog results are not bundled with the application.

Principal UI/runtime dependencies include React (MIT), Zustand (MIT), TanStack Query (MIT), Lucide (ISC), qrcode.react (ISC), and Tauri (MIT OR Apache-2.0). Consult the installed package/crate notices and lockfiles for exact versions and the full dependency graph.

The QRC decoding module at `src-tauri/src/infrastructure/providers/qrc_codec.rs` is adapted from [J0R6IT0/navidrome-lyrics-plugin](https://github.com/J0R6IT0/navidrome-lyrics-plugin/blob/4b78b89bd53ddf78dfb15769379347a37cd23e92/src/providers/qqmusic/qrc.rs), commit `4b78b89bd53ddf78dfb15769379347a37cd23e92`, under the MIT License, Copyright (c) 2026 Jorge Pardo. The complete permission and warranty notice is retained in the source file and in `licenses/qrc-codec-MIT.txt`. BiliMusic retains only the decoder and adds size bounds. Base64 decoding uses the `base64` crate (MIT OR Apache-2.0).

Desktop system media controls use [souvlaki](https://github.com/Sinono3/souvlaki), distributed under the MIT license.
