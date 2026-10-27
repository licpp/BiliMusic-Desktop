# Android native player

Local Tauri plugin used only on Android. `PlayerPlugin` exposes play/control/snapshot and a state event; `PlaybackService` owns MediaPlayer, the foreground notification, MediaSession and audio focus. Rust registers the native bridge; the shared player store owns the music queue and resolves playable URLs through the Rust loopback proxy.

Permissions are restricted to the Android main window. Only loopback HTTP URLs produced by the backend are accepted. The service is not exported and does not restart automatically after process termination. No broad storage permissions are requested.
