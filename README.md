# Resonance

Resonance is the working title for a clean-room desktop music client built with Tauri 2, Rust, React, and SQLite. The name and branding are temporary until trademark and package-name checks are completed.

## Status

Milestone 0 is in progress: application shell, original visual system, domain identity, database schema, and desktop bootstrap.

## Development

```bash
npm install
npm run dev
```

Running the native desktop shell additionally requires the Rust toolchain and platform prerequisites:

```bash
npm run tauri dev
```

## Architecture

- `src/domain`: platform-independent TypeScript domain contracts.
- `src/features`: feature-owned UI and state.
- `src/shared`: narrowly scoped shared UI and utilities.
- `src-tauri/src/domain`: Rust domain types.
- `src-tauri/src/application`: use cases and state machines.
- `src-tauri/src/infrastructure`: SQLite, HTTP, providers, downloads, and platform adapters.
- `src-tauri/src/interface`: typed Tauri command boundary.

See `CLEAN_ROOM.md` before contributing.
