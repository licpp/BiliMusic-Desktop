import AVFoundation
import MediaPlayer
import Security
import SwiftRs
import Tauri
import UIKit
import WebKit

struct Source: Codable {
    let provider: String; let bvid: String; let cid: Int64; let page: Int
    let aid: Int64?; let uploaderId: Int64?; let uploaderName: String?
}
struct QueueTrack: Codable {
    let id: String; let source: Source
    var title: String; var artist: String?; var album: String?; var coverUrl: String?
    var durationSeconds: Double; var liked: Bool?; var resolveParts: Bool?; var videoTitle: String?; var partCount: Int?
}
struct PlayArgs: Decodable {
    let url: String; let id: String; let position: Double?; let volume: Double?; let playing: Bool?; let rate: Double?; let collectionRef: String?
}
struct ControlArgs: Decodable {
    let action: String; let value: Double?; let id: String?; let collectionRef: String?
}
struct QueueArgs: Decodable {
    let tracks: [QueueTrack]; let repeatMode: String; let shuffled: Bool; let autoResume: Bool?
}
struct SecretArgs: Decodable {
    let key: String; let value: String?; let remove: Bool?
}
struct ExportArgs: Decodable { let path: String }
struct ListenerArgs: Decodable { let event: String; let handler: Channel }
struct RemoveListenerArgs: Decodable { let event: String; let channelId: UInt64 }
struct PlayerSnapshot: Encodable {
    var id: String?
    var status = "paused"
    var rate: Double = 1
    var position: Double = 0
    var duration: Double = 0
    var stopped = true
    var error: String?
    var track: QueueTrack?
    var revision: Int64 = 0
    var recoveryAttempted = false
    var expandedEntries: [String: [QueueTrack]]?
    var sleepDeadline: Double = 0
    var sleepDuration: Double = 0
    var sleepExpired = false
}
struct ResolveRequest: Encodable {
    let profile: String; let track: QueueTrack; let restart: Bool; let autoResume: Bool
    let refresh: Bool; let position: Double?
}
struct ResolvedTrack: Decodable {
    let url: String?; let track: QueueTrack?; let error: String?
    let position: Double?; let entryId: String?; let parts: [QueueTrack]?
}

@_silgen_name("bilimusic_ios_resolve")
private func resolveTrack(_ request: Int64, _ json: UnsafePointer<CChar>)
@_silgen_name("bilimusic_ios_profile")
private func currentProfile() -> UnsafeMutablePointer<CChar>?
@_silgen_name("bilimusic_ios_free")
private func freeProfile(_ value: UnsafeMutablePointer<CChar>)
@_silgen_name("bilimusic_ios_listen")
private func recordNativeListening(_ json: UnsafePointer<CChar>)
private weak var activePlayer: PlayerPlugin?

// Copy the Rust result before returning; the pointer is valid only during this call.
@_cdecl("bilimusic_ios_resolved")
func didResolve(_ request: Int64, _ json: UnsafePointer<CChar>) {
    let data = Data(String(cString: json).utf8)
    DispatchQueue.main.async { activePlayer?.resolved(request, data) }
}

class PlayerPlugin: Plugin {
    private var sleepWork: DispatchWorkItem?
    private var sleepEndsAt: TimeInterval = 0
    private var sleepDeadline: Double = 0
    private var sleepDuration: Double = 0
    private var sleepExpired = false
    private var fullscreenState: (orientation: UIInterfaceOrientation, mask: UIInterfaceOrientationMask, statusHidden: Bool, homeHidden: Bool)?
    private var listeningAt = ProcessInfo.processInfo.systemUptime
    private var listeningActive = false
    private var listeningID: String?
    private var listeningProfile = ""
    private var listeningSeconds: Double = 0
    private let player = AVPlayer()
    private var state = PlayerSnapshot()
    private var tracks: [QueueTrack] = []
    private var expandedEntries: [String: [QueueTrack]] = [:]
    private var collectionRef: String?
    private var positionSavedAt: TimeInterval = 0
    private var didFinishTrack = false
    private var listeners: [UInt64: Channel] = [:]
    private var repeatMode = "off"
    private var shuffled = false
    private var autoResume = true
    private var generation: Int64 = 0
    private var profile = ""
    private var playbackRate: Float = 1
    private var desiredPlaying = false
    private var startPosition: Double = 0
    private var initialSeekPending = false
    private var resumeAfterInterruption = false
    private var pausedAt: TimeInterval?
    private var recoveryAttempted = false
    private var playbackWatchdog: DispatchWorkItem?
    private var itemStatus: NSKeyValueObservation?
    private var timeStatus: NSKeyValueObservation?
    private var timeObserver: Any?
    private var notifications: [NSObjectProtocol] = []
    private var remoteTargets: [(MPRemoteCommand, Any)] = []
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private weak var webview: WKWebView?
    private let artworkCache = NSCache<NSString, UIImage>()
    private var artworkTask: URLSessionDataTask?
    private var artworkURL: String?
    private var artwork: MPMediaItemArtwork?
    private var nowPlayingScheduled = false
    private var lastNowPlayingAt: TimeInterval = 0
    private var lastNowPlayingPosition: Double = 0
    private var lastNowPlayingStatus = ""
    private var lastNowPlayingID: String?

    override func load(webview: WKWebView) {
        self.webview = webview
        activePlayer = self
        webview.scrollView.contentInsetAdjustmentBehavior = .never
        webview.scrollView.bounces = false
        webview.scrollView.minimumZoomScale = 1
        webview.scrollView.maximumZoomScale = 1
        webview.scrollView.pinchGestureRecognizer?.isEnabled = false
        player.automaticallyWaitsToMinimizeStalling = true
        timeStatus = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.refresh() }
        }
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] _ in self?.refresh() }
        let center = NotificationCenter.default
        notifications.append(center.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main) { [weak self] note in
            guard let view = self?.webview, let window = view.window,
                  let screenFrame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
            let frame = view.convert(window.convert(screenFrame, from: window.screen.coordinateSpace), from: window)
            let overlap = frame.maxY >= view.bounds.maxY - 1 ? max(0, view.bounds.maxY - frame.minY) : 0
            view.evaluateJavaScript("document.documentElement.style.setProperty('--native-keyboard','\(overlap)px'); window.dispatchEvent(new Event('bilimusic-keyboard'));")
        })
        notifications.append(center.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: nil, queue: .main) { [weak self] note in
            guard let self = self, let item = note.object as? AVPlayerItem, item === self.player.currentItem else { return }
            self.advance(1, ended: true)
        })
        notifications.append(center.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: nil, queue: .main) { [weak self] note in
            guard let self = self, let item = note.object as? AVPlayerItem, item === self.player.currentItem else { return }
            self.playbackFailed()
        })
        notifications.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in self?.interrupted(note) })
        notifications.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            if (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue { self?.pause() }
        })
        notifications.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.refresh() })
        notifications.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.accountListening(flush: true); self?.savePosition(force: true)
        })
        bindRemoteCommands()
    }
    deinit {
        playbackWatchdog?.cancel()
        if let observer = timeObserver { player.removeTimeObserver(observer) }
        notifications.forEach { NotificationCenter.default.removeObserver($0) }
        remoteTargets.forEach { $0.0.removeTarget($0.1) }
    }

    @objc public func play(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(PlayArgs.self)
        onMain { [self] in
            guard let url = localMediaURL(args.url), args.position?.isFinite != false, args.volume?.isFinite != false else { invoke.reject("无效的本机音频地址"); return }
            accountListening(flush: true)
            guard state.id == args.id else { invoke.reject("歌曲已切换"); return }
            savePosition(force: true)
            collectionRef = args.collectionRef
            recoveryAttempted = false; pausedAt = nil
            playbackRate = Float(min(2, max(0.75, args.rate ?? 1)))
            generation += 1; state.revision = generation
            state.id = args.id; state.track = tracks.first { $0.id == args.id }
            prepareArtwork(for: state.track)
            state.duration = state.track?.durationSeconds ?? 0
            player.volume = Float(min(1, max(0, args.volume ?? 0.7)))
            do { try start(url, at: max(0, args.position ?? 0), autoplay: args.playing ?? true); invoke.resolve() }
            catch { fail("无法启动 iOS 音频：\(error.localizedDescription)"); invoke.reject(error.localizedDescription) }
        }
    }
    @objc public func queue(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(QueueArgs.self)
        onMain { [self] in
            guard args.tracks.count <= 10000, ["off", "one", "all"].contains(args.repeatMode) else { invoke.reject("无效的播放队列"); return }
            var seen = Set<String>()
            expandedEntries = expandedEntries.filter { key, _ in args.tracks.contains { $0.id == key && $0.resolveParts == true } }
            tracks = args.tracks.flatMap { track in
                if track.resolveParts == true, let parts = expandedEntries[track.id] { return parts }
                return [track]
            }.filter { seen.insert($0.id).inserted }
            repeatMode = args.repeatMode; shuffled = args.shuffled; autoResume = args.autoResume ?? true
            if let track = tracks.first(where: { $0.id == state.id }) { state.track = track; prepareArtwork(for: track); nowPlaying() }
            invoke.resolve()
        }
    }
    @objc public func control(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ControlArgs.self)
        onMain { [self] in
            switch args.action {
            case "prepare":
                playbackWatchdog?.cancel()
                recoveryAttempted = false; pausedAt = nil
                savePosition(force: true)
                accountListening(flush: true)
                guard let raw = currentProfile() else { invoke.reject("无法读取当前播放账号"); return }
                profile = String(cString: raw); freeProfile(raw)
                generation += 1; desiredPlaying = false; itemStatus = nil
                player.pause(); player.replaceCurrentItem(with: nil)
                endBackgroundTask()
                state = PlayerSnapshot(id: args.id, status: "buffering", revision: generation); publish()
            case "collection":
                if state.id == args.id && collectionRef != args.collectionRef {
                    savePosition(force: true)
                    collectionRef = args.collectionRef
                    savePosition(force: true)
                }
            case "stop": stop()
            case "sleepStart":
                guard state.id != nil, let seconds = args.value, (60...10800).contains(seconds) else { invoke.reject("请先开始播放并选择定时时长"); return }
                scheduleSleep(seconds)
            case "sleepCancel": clearSleep(); publish()
            case "sleepDismiss": sleepExpired = false; publish()
            case "sleepRepeat":
                guard sleepExpired, sleepDuration > 0 else { invoke.resolve(); return }
                scheduleSleep(sleepDuration); resume()
            case "pause": pause()
            case "resume": resume()
            case "seek": seek(args.value ?? 0)
            case "rate":
                if let value = args.value, value.isFinite, (0.75...2).contains(value) {
                    playbackRate = Float(value)
                    if desiredPlaying && !initialSeekPending && player.currentItem?.status == .readyToPlay {
                        player.playImmediately(atRate: playbackRate)
                    }
                    refresh()
                    nowPlaying()
                }
            case "volume": player.volume = Float(min(1, max(0, args.value ?? 0.7)))
            case "theme":
                let light = args.value == 1
                webview?.window?.overrideUserInterfaceStyle = light ? .light : .dark
                webview?.isOpaque = false
                webview?.backgroundColor = light ? UIColor(white: 0.96, alpha: 1) : UIColor(red: 0.027, green: 0.063, blue: 0.098, alpha: 1)
            case "immersive": break
            case "videoFullscreen": setVideoFullscreen(args.value == 1)
            default: invoke.reject("不支持的播放操作"); return
            }
            invoke.resolve()
        }
    }
    private func setVideoFullscreen(_ enabled: Bool) {
        guard let window = webview?.window, let scene = window.windowScene, let controller = window.rootViewController else { return }
        if enabled && fullscreenState != nil { return }
        if !enabled && fullscreenState == nil { return }
        if enabled {
            fullscreenState = (scene.interfaceOrientation, controller.supportedInterfaceOrientations, controller.prefersStatusBarHidden, controller.prefersHomeIndicatorAutoHidden)
        }
        guard let previous = fullscreenState else { return }
        let orientation = enabled ? (scene.interfaceOrientation.isLandscape ? scene.interfaceOrientation : .landscapeRight) : previous.orientation
        let supported = enabled ? UIInterfaceOrientationMask.landscape : previous.mask
        // These setters belong to the vendored Tao view controller. Check them
        // before using KVC; no UIDevice private orientation API is involved.
        for (selector, key, value) in [
            ("setSupportedInterfaceOrientations:", "supportedInterfaceOrientations", NSNumber(value: supported.rawValue)),
            ("setPrefersStatusBarHidden:", "prefersStatusBarHidden", NSNumber(value: enabled || previous.statusHidden)),
            ("setPrefersHomeIndicatorAutoHidden:", "prefersHomeIndicatorAutoHidden", NSNumber(value: enabled || previous.homeHidden))
        ] {
            if controller.responds(to: NSSelectorFromString(selector)) { controller.setValue(value, forKey: key) }
        }
        if !enabled { fullscreenState = nil }
        if #available(iOS 16.0, *) {
            controller.setNeedsUpdateOfSupportedInterfaceOrientations()
            let target: UIInterfaceOrientationMask
            switch orientation {
            case .landscapeLeft: target = .landscapeLeft
            case .landscapeRight: target = .landscapeRight
            case .portraitUpsideDown: target = .portraitUpsideDown
            default: target = .portrait
            }
            // CSS provides landscape presentation while rotation is pending or
            // unavailable (including iOS 15 and orientation-locked scenes).
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: target), errorHandler: { _ in })
        } else {
            UIViewController.attemptRotationToDeviceOrientation()
        }
    }
    @objc public func export_download(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ExportArgs.self)
        onMain { [self] in
            guard var presenter = webview?.window?.rootViewController else {
                invoke.reject("无法打开分享面板"); return
            }
            while let presented = presenter.presentedViewController { presenter = presented }
            let share = UIActivityViewController(activityItems: [URL(fileURLWithPath: args.path)], applicationActivities: nil)
            if let popover = share.popoverPresentationController, let view = presenter.view {
                popover.sourceView = view
                popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
            }
            presenter.present(share, animated: true)
            invoke.resolve()
        }
    }

    @objc public func snapshot(_ invoke: Invoke) { onMain { [self] in refresh(); invoke.resolve(state) } }

    @objc public func register_listener(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ListenerArgs.self)
        guard args.event == "state" else { invoke.reject("不支持的播放事件"); return }
        onMain { [self] in listeners[args.handler.id] = args.handler; invoke.resolve() }
    }
    @objc public func remove_listener(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(RemoveListenerArgs.self)
        onMain { [self] in listeners.removeValue(forKey: args.channelId); invoke.resolve() }
    }
    private func onMain(_ work: @escaping () -> Void) {
        if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
    }

    // Rust-only; deliberately absent from the JavaScript command permissions.
    @objc public func secret(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SecretArgs.self)
        guard args.key.range(of: "^sync-[0-9]+-(cloud|webdav)$", options: .regularExpression) != nil else { invoke.reject("无效的凭据标识"); return }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "app.bilimusic.sync", kSecAttrAccount as String: args.key]
        if args.remove == true {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { invoke.reject("无法删除同步凭据"); return }
            invoke.resolve(); return
        }
        if let value = args.value {
            let attrs: [String: Any] = [kSecValueData as String: Data(value.utf8), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
            let status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
            if status == errSecItemNotFound {
                var create = query; attrs.forEach { create[$0.key] = $0.value }
                guard SecItemAdd(create as CFDictionary, nil) == errSecSuccess else { invoke.reject("无法保存同步凭据"); return }
            } else if status != errSecSuccess { invoke.reject("无法保存同步凭据"); return }
            invoke.resolve(); return
        }
        var read = query; read[kSecReturnData as String] = true; read[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(read as CFDictionary, &result)
        if status == errSecItemNotFound { invoke.resolve(["value": nil] as JsonObject); return }
        guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else { invoke.reject("无法读取同步凭据，请重新连接"); return }
        invoke.resolve(["value": value])
    }
    private func localMediaURL(_ value: String) -> URL? {
        guard let url = URL(string: value), url.scheme == "http", url.host == "127.0.0.1", url.port != nil, url.user == nil, url.password == nil, url.path.split(separator: "/").count == 2 else { return nil }
        return url
    }
    private func activate() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default, options: [])
        try session.setActive(true)
    }
    private func start(_ url: URL, at position: Double = 0, autoplay: Bool = true) throws {
        didFinishTrack = false
        positionSavedAt = ProcessInfo.processInfo.systemUptime - 15
        accountListening(flush: true)
        try activate(); desiredPlaying = autoplay
        state.error = nil; state.stopped = false; state.status = autoplay ? "buffering" : "paused"; state.position = position; startPosition = position; initialSeekPending = position > 0
        let item = AVPlayerItem(url: url); item.preferredForwardBufferDuration = 4
        itemStatus = nil; player.replaceCurrentItem(with: item)
        let request = generation
        itemStatus = item.observe(\.status, options: [.new, .initial]) { [weak self] item, _ in
            DispatchQueue.main.async {
                guard let self = self, self.generation == request, item === self.player.currentItem else { return }
                if item.status == .failed {
                    let error = item.error as NSError?
                    if let error { NSLog("BiliMusic audio item failed: %@ (%ld)", error.domain, error.code) }
                    self.playbackFailed()
                    return
                }
                if item.status == .readyToPlay {
                    let position = self.startPosition; self.startPosition = 0
                    if position > 0 {
                        self.state.position = position
                        self.player.seek(to: CMTime(seconds: position, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] completed in
                            self?.onMain { [weak self] in
                                guard let self, self.generation == request, item === self.player.currentItem else { return }
                                self.initialSeekPending = false
                                if completed && self.desiredPlaying { self.player.playImmediately(atRate: self.playbackRate) }
                                self.endBackgroundTask(); self.refresh()
                            }
                        }
                    } else {
                        if self.desiredPlaying && self.player.timeControlStatus != .playing { self.player.playImmediately(atRate: self.playbackRate) }
                        self.endBackgroundTask(); self.refresh()
                    }
                }
            }
        }
        if autoplay { watchPlayback() }
        if autoplay && position == 0 { player.playImmediately(atRate: playbackRate) } else { player.pause() }; accountListening(); publish()
    }
    private func clearSleep() {
        sleepWork?.cancel()
        sleepWork = nil
        sleepEndsAt = 0; sleepDeadline = 0; sleepDuration = 0; sleepExpired = false
    }
    private func scheduleSleep(_ seconds: Double) {
        clearSleep()
        sleepDuration = seconds
        sleepEndsAt = ProcessInfo.processInfo.systemUptime + seconds
        sleepDeadline = (Date().timeIntervalSince1970 + seconds) * 1000
        let work = DispatchWorkItem { [weak self] in _ = self?.expireSleepIfNeeded() }
        sleepWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
        publish()
    }
    @discardableResult
    private func expireSleepIfNeeded() -> Bool {
        guard sleepEndsAt > 0,
              ProcessInfo.processInfo.systemUptime >= sleepEndsAt || Date().timeIntervalSince1970 * 1000 >= sleepDeadline
        else { return false }
        sleepWork?.cancel(); sleepWork = nil
        sleepEndsAt = 0; sleepDeadline = 0; sleepExpired = true
        pause()
        return true
    }
    private func pause() {
        playbackWatchdog?.cancel()
        if pausedAt == nil { pausedAt = Date().timeIntervalSince1970 }
        savePosition(force: true)
        accountListening(flush: true)
        resumeAfterInterruption = false
        desiredPlaying = false
        if state.stopped { generation += 1; state.revision = generation }
        player.pause(); state.status = "paused"; endBackgroundTask(); publish()
    }
    private func resume() {
        if expireSleepIfNeeded() { return }
        if desiredPlaying && state.status == "buffering" && state.stopped { return }
        recoveryAttempted = false
        let stale = pausedAt.map { Date().timeIntervalSince1970 - $0 >= 300 } ?? false
        pausedAt = nil
        if player.currentItem?.status == .failed || state.error != nil || stale {
            if recoverCurrentPlayback() { return }
        }
        guard player.currentItem != nil else {
            if let track = state.track ?? tracks.first(where: { $0.id == state.id }) { resolve(track) }; return
        }
        do {
            try activate()
            let position = player.currentTime().seconds
            if state.duration > 0 && position.isFinite && position >= state.duration - 0.25 { seek(0) }
            desiredPlaying = true; player.playImmediately(atRate: playbackRate); watchPlayback(); refresh()
        } catch { fail("无法恢复播放") }
    }
    @discardableResult
    private func recoverCurrentPlayback() -> Bool {
        guard !recoveryAttempted, let track = state.track ?? tracks.first(where: { $0.id == state.id }) else { return false }
        let current = player.currentTime().seconds
        let position = current.isFinite && current > 0 && !initialSeekPending ? current : max(state.position, startPosition)
        recoveryAttempted = true
        resolve(track, refresh: true, position: position)
        return true
    }
    private func playbackFailed() {
        // Recreate failed items natively so lock-screen playback recovers while
        // the WebView is suspended. One refresh is allowed per user attempt.
        if desiredPlaying && recoverCurrentPlayback() { return }
        fail("音频连接已失效，请点击播放重试")
    }
    private func watchPlayback() {
        playbackWatchdog?.cancel()
        let request = generation
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.generation == request, self.desiredPlaying, self.player.timeControlStatus != .playing else { return }
            self.playbackFailed()
        }
        playbackWatchdog = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 12, execute: work)
    }
    private var seekRevision = 0
    private func seek(_ seconds: Double) {
        accountListening(flush: true)
        guard seconds.isFinite else { return }
        didFinishTrack = false
        let target = max(0, min(seconds, state.duration > 0 ? state.duration : seconds))
        seekRevision += 1
        let revision = seekRevision
        let item = player.currentItem
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] completed in
            self?.onMain { [weak self] in
                guard let self, completed, self.seekRevision == revision, self.player.currentItem === item else { return }
                self.savePosition(force: true)
                self.refresh()
            }
        }
        state.position = target; publish()
    }
    private func stop() {
        playbackWatchdog?.cancel()
        pausedAt = nil; recoveryAttempted = false
        clearSleep()
        savePosition(force: true)
        accountListening(flush: true)
        resumeAfterInterruption = false
        generation += 1; desiredPlaying = false; itemStatus = nil
        player.pause(); player.replaceCurrentItem(with: nil)
        state = PlayerSnapshot(revision: generation); tracks = []; expandedEntries = [:]; endBackgroundTask()
        artworkTask?.cancel(); artworkTask = nil; artworkURL = nil; artwork = nil
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        publish()
    }
    private func fail(_ message: String) {
        playbackWatchdog?.cancel()
        accountListening(flush: true)
        resumeAfterInterruption = false
        desiredPlaying = false; player.pause(); state.status = "error"; state.error = message; endBackgroundTask(); publish()
    }
    private func accountListening(flush: Bool = false) {
        let now = ProcessInfo.processInfo.systemUptime
        if listeningActive { listeningSeconds += max(0, min(300, now - listeningAt)) }
        listeningAt = now
        if flush || listeningID != state.id || listeningProfile != profile || listeningSeconds >= 15 {
            if let id = listeningID, listeningSeconds > 0, let data = try? JSONSerialization.data(withJSONObject: ["profile": listeningProfile, "id": id, "seconds": min(300, listeningSeconds)]), let json = String(data: data, encoding: .utf8) { json.withCString { recordNativeListening($0) } }
            listeningSeconds = 0
        }
        listeningID = state.id; listeningProfile = profile
        listeningActive = player.timeControlStatus == .playing
    }
    private func savePosition(force: Bool = false, completed: Bool = false) {
        guard let id = state.id, player.currentItem?.status == .readyToPlay, !initialSeekPending else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if !force && now - positionSavedAt < 15 { return }
        let position = player.currentTime().seconds
        guard position.isFinite else { return }
        let duration = state.duration
        let saved = completed || didFinishTrack || position < 1 || (duration > 0 && position >= duration - 1) ? 0 : position
        positionSavedAt = now
        let millis = Int64(Date().timeIntervalSince1970 * 1000)
        var sample: [String: Any] = ["profile": profile, "id": id, "position": saved, "observedAt": millis]
        if let collectionRef { sample["collectionRef"] = collectionRef }
        if let data = try? JSONSerialization.data(withJSONObject: sample),
           let json = String(data: data, encoding: .utf8) { json.withCString { recordNativeListening($0) } }
    }
    private func refresh() {
        if expireSleepIfNeeded() { return }
        if player.timeControlStatus == .playing { playbackWatchdog?.cancel() }
        if let item = player.currentItem {
            let position = player.currentTime().seconds, duration = item.duration.seconds
            if position.isFinite && !initialSeekPending && item.status != .failed { state.position = max(0, position) }
            if duration.isFinite && duration > 0 { state.duration = duration }
            if desiredPlaying && player.timeControlStatus == .playing { savePosition() }
            if state.error == nil { state.status = desiredPlaying ? (player.timeControlStatus == .playing ? "playing" : "buffering") : "paused" }
        }
        publish()
    }
    private func publish() {
        state.recoveryAttempted = recoveryAttempted
        state.rate = Double(playbackRate)
        state.expandedEntries = expandedEntries.isEmpty ? nil : expandedEntries
        state.sleepDeadline = sleepDeadline
        state.sleepDuration = sleepDuration
        state.sleepExpired = sleepExpired
        accountListening()
        // Deliver playback state before scheduling the system media presentation.
        // Transport commands must not await lock-screen / Dynamic Island updates.
        for channel in listeners.values { try? channel.send(state) }
        // The SDK may register through its inherited camelCase fallback. Those
        // channels belong to Plugin, not to this class's compatibility registry.
        try? trigger("state", data: state)
        if state.id != lastNowPlayingID || state.status != lastNowPlayingStatus || abs(state.position - lastNowPlayingPosition) > 5 || ProcessInfo.processInfo.systemUptime - lastNowPlayingAt > 5 {
            nowPlaying()
        }
    }
    private func nowPlaying() {
        guard !nowPlayingScheduled else { return }
        nowPlayingScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.nowPlayingScheduled = false
            self.writeNowPlaying()
        }
    }
    private func writeNowPlaying() {
        guard let id = state.id else { return }
        lastNowPlayingAt = ProcessInfo.processInfo.systemUptime
        lastNowPlayingPosition = state.position
        lastNowPlayingStatus = state.status
        lastNowPlayingID = id
        var info: [String: Any] = [MPMediaItemPropertyTitle: state.track?.title ?? "BiliMusic", MPMediaItemPropertyArtist: state.track?.artist ?? "歌手未知", MPNowPlayingInfoPropertyExternalContentIdentifier: id,
                                  MPNowPlayingInfoPropertyElapsedPlaybackTime: state.position, MPNowPlayingInfoPropertyPlaybackRate: state.status == "playing" ? Double(playbackRate) : 0.0]
        if state.duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = state.duration }
        if let album = state.track?.album { info[MPMediaItemPropertyAlbumTitle] = album }
        if let artwork { info[MPMediaItemPropertyArtwork] = artwork }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
    private func prepareArtwork(for track: QueueTrack?) {
        let value = track?.coverUrl?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let value, !value.isEmpty, let url = URL(string: value), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
            artworkTask?.cancel(); artworkTask = nil; artworkURL = nil; artwork = nil; nowPlaying(); return
        }
        guard artworkURL != value else { return }
        artworkTask?.cancel(); artworkTask = nil; artworkURL = value; artwork = nil
        if let cached = artworkCache.object(forKey: value as NSString) { installArtwork(cached, url: value); return }
        var request = URLRequest(url: url, cachePolicy: .returnCacheDataElseLoad, timeoutInterval: 12)
        request.setValue("https://www.bilibili.com/", forHTTPHeaderField: "Referer")
        request.setValue("Mozilla/5.0 BiliMusic/iOS", forHTTPHeaderField: "User-Agent")
        artworkTask = URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let self, self.artworkURL == value, let data, let image = UIImage(data: data) else { return }
            self.artworkCache.setObject(image, forKey: value as NSString)
            DispatchQueue.main.async { if self.artworkURL == value { self.installArtwork(image, url: value) } }
        }
        artworkTask?.resume()
    }
    private func installArtwork(_ image: UIImage, url: String) {
        guard artworkURL == url else { return }
        artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
        nowPlaying()
    }
    private func advance(_ direction: Int, ended: Bool = false) {
        if expireSleepIfNeeded() { return }
        if direction < 0 && state.position > 4 { seek(0); return }
        guard !tracks.isEmpty else { pause(); return }
        let index = tracks.firstIndex { $0.id == state.id } ?? -1
        if ended { didFinishTrack = true; savePosition(force: true, completed: true) }
        if ended && repeatMode == "one", let track = state.track { resolve(track, restart: true); return }
        if ended && !shuffled && repeatMode == "off" && index == tracks.count - 1 { pause(); return }
        let target = shuffled && tracks.count > 1 ? (max(0, index) + Int.random(in: 1..<tracks.count)) % tracks.count : (index + direction + tracks.count) % tracks.count
        resolve(tracks[target])
    }
    private func resolve(_ track: QueueTrack, restart: Bool = false, refresh: Bool = false, position: Double? = nil) {
        playbackWatchdog?.cancel()
        if !refresh { recoveryAttempted = false }
        if state.id != track.id { savePosition(force: true) }
        accountListening(flush: true)
        generation += 1; state.revision = generation; desiredPlaying = true; itemStatus = nil
        player.pause(); player.replaceCurrentItem(with: nil)
        state.id = track.id; state.track = track; state.position = position ?? 0; state.duration = track.durationSeconds
        prepareArtwork(for: track)
        state.error = nil; state.status = "buffering"; state.stopped = true
        endBackgroundTask()
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "BiliMusic next track") { [weak self] in self?.fail("后台加载超时，请返回应用继续播放") }
        publish()
        guard let data = try? JSONEncoder().encode(ResolveRequest(profile: profile, track: track, restart: restart, autoResume: autoResume, refresh: refresh, position: position)),
              let json = String(data: data, encoding: .utf8) else { fail("无法读取歌曲信息"); return }
        json.withCString { resolveTrack(generation, $0) }
    }
    fileprivate func resolved(_ request: Int64, _ data: Data) {
        guard request == generation, desiredPlaying else { return }
        guard let result = try? JSONDecoder().decode(ResolvedTrack.self, from: data) else { fail("无法解析播放地址"); return }
        if let error = result.error { fail(error); return }
        guard let raw = result.url, let url = localMediaURL(raw) else { fail("无法解析播放地址"); return }
        if let id = result.entryId, let parts = result.parts, !parts.isEmpty,
           let index = tracks.firstIndex(where: { $0.id == id && $0.resolveParts == true }) {
            expandedEntries[id] = parts
            tracks.replaceSubrange(index...index, with: parts)
        }
        if let track = result.track {
            state.id = track.id; state.track = track; state.duration = track.durationSeconds
            prepareArtwork(for: track)
        }
        do { try start(url, at: result.position ?? 0) } catch { fail(error.localizedDescription) }
    }
    private func endBackgroundTask() {
        if backgroundTask != .invalid { UIApplication.shared.endBackgroundTask(backgroundTask); backgroundTask = .invalid }
    }
    private func interrupted(_ note: Notification) {
        guard let value = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt, let type = AVAudioSession.InterruptionType(rawValue: value) else { return }
        if type == .began {
            let wasPlaying = desiredPlaying; pause(); resumeAfterInterruption = wasPlaying
        } else {
            let options = AVAudioSession.InterruptionOptions(rawValue: note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
            if resumeAfterInterruption && options.contains(.shouldResume) { resume() }; resumeAfterInterruption = false
        }
    }
    private func bindRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        func bind(_ command: MPRemoteCommand, _ work: @escaping () -> Void) {
            command.isEnabled = true
            remoteTargets.append((command, command.addTarget { _ in DispatchQueue.main.async(execute: work); return .success }))
        }
        bind(center.playCommand) { [weak self] in self?.resume() }
        bind(center.pauseCommand) { [weak self] in self?.pause() }
        bind(center.togglePlayPauseCommand) { [weak self] in guard let self = self else { return }; if self.desiredPlaying { self.pause() } else { self.resume() } }
        bind(center.nextTrackCommand) { [weak self] in self?.advance(1) }
        bind(center.previousTrackCommand) { [weak self] in self?.advance(-1) }
        center.changePlaybackPositionCommand.isEnabled = true
        remoteTargets.append((center.changePlaybackPositionCommand, center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            DispatchQueue.main.async { self?.seek(event.positionTime) }; return .success
        }))
    }
}
@_cdecl("init_plugin_ios_player")
func initPlugin() -> Plugin { PlayerPlugin() }
