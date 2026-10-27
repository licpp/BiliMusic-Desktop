# Third-party notices

This project depends on third-party Rust crates and npm packages. Their respective licenses remain in effect and are not replaced by the project's MIT license.

Public releases include `THIRD_PARTY_LICENSES.json`, with dependency versions, declared licenses, and available license text, alongside `LICENSE`, this notice, and a SHA-256 file list. The first public 0.1.4 release uses dependency metadata for both macOS and Windows from the release source commit. Future release CI generates platform-specific reports with `scripts/release-notices.mjs`. Additional recommended checks:

- Rust: `cargo deny check licenses`
- npm: an SPDX-compatible license report generated from the lockfile

The project does not bundle media, lyrics, comments, danmaku, or branding from Bilibili or any metadata provider. Availability of a provider adapter does not imply affiliation or authorization by that provider.

Runtime services used by the current implementation:

- Bilibili: search, playback sources, account QR login, comments and danmaku. Requests originate from the native provider and are subject to platform availability and account permissions.
- LRCLIB: lyric search and lyric candidates.
- NetEase Cloud Music: fallback lyric search and lyric candidates when LRCLIB is unavailable or has no results. No audio is obtained from this provider.
- Apple iTunes Search API: album and artwork candidates. Catalog results are not bundled with the application.

Principal UI/runtime dependencies include React (MIT), Zustand (MIT), TanStack Query (MIT), Lucide (ISC), qrcode.react (ISC), and Tauri (MIT OR Apache-2.0). Consult the installed package/crate notices and lockfiles for exact versions and the full dependency graph.
