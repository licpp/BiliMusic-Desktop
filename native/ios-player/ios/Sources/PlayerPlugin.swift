import AVFoundation
import MediaPlayer
import MetricKit
import Security
import SwiftRs
import Tauri
import UIKit
import WebKit

struct PlayArgs: Decodable {
    let url: String; let id: String; let position: Double?; let volume: Double?; let playing: Bool?; let rate: Double?; let collectionRef: String?; let seamless: Bool?
    let track: QueueTrack?
    let loudnessGainDb: Double?; let loudnessEnabled: Bool?; let loudnessRevision: Double?
    let upgradeUrl: String?
    let automaticResume: AutomaticResumePolicy?
    let diagnosticId: String?
    let accountSession: String?
}
struct ControlArgs: Decodable {
    let settingsRevision: Double?
    let action: String; let value: Double?; let id: String?; let collectionRef: String?
    let track: QueueTrack?
    /// Theme actions send the preference (`light`, `dark`, `system`) so the
    /// native window can be handed back to the OS instead of pinned to a colour.
    let theme: String?
}
struct QueueArgs: Decodable {
    let offlineOnly: Bool?
    let accountSession: String?; let version: Int64?; let owner: String?
    let entryOrigins: [String:[String]]?
    let entryOrder: [String]?
    let tracks: [QueueTrack]; let repeatMode: String; let shuffled: Bool; let autoResume: Bool?
    let resumeThresholdSeconds: Double?; let collectionPlayback: Bool?
}
struct SecretArgs: Decodable {
    let key: String; let value: String?; let remove: Bool?
}
struct ExportArgs: Decodable { let path: String }
struct ListenerArgs: Decodable { let event: String; let handler: Channel }
struct RemoveListenerArgs: Decodable { let event: String; let channelId: UInt64 }
struct ResolveRequest: Encodable {
    let diagnosticId: String?
    let initialErrorCode: String?
    let offlineOnly: Bool
    let visibilityScopes: [String]
    let accountSession: String?
    let profile: String; let track: QueueTrack; let restart: Bool; let autoResume: Bool
    let resumeThresholdSeconds: Double; let collectionPlayback: Bool
    let refresh: Bool; let position: Double?
    let subtitles: Bool; let subtitleLanguage: String; let subtitleRevision: Int
}
struct ResolvedTrack: Decodable {
    let skip: Bool?
    let loudnessGainDb: Double?
    let url: String?; let track: QueueTrack?; let error: String?; let errorCode: String?
    let upgradeUrl: String?
    let automaticResume: AutomaticResumePolicy?
    let position: Double?; let entryId: String?; let parts: [QueueTrack]?; let lyrics: NativeSavedLyrics?
    let kind: String?; let id: String?; let timeline: NativeSavedLyrics?; let subtitleRevision: Int?; let accountSession: String?
}

@_silgen_name("bilimusic_ios_diagnostic_exit")
private func diagnosticExit(_ kind: Int32, _ at: UInt64)

@available(iOS 14.0, *)
private final class PlaybackMetricSubscriber: NSObject, MXMetricManagerSubscriber {
    static let shared = PlaybackMetricSubscriber()
    static let registered: Void = { MXMetricManager.shared.add(shared) }()

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        for payload in payloads {
            let timestamp = payload.timeStampEnd.timeIntervalSince1970 * 1000
            guard timestamp.isFinite, timestamp > 0 else { continue }
            if payload.crashDiagnostics?.isEmpty == false { diagnosticExit(1, UInt64(timestamp)) }
            if payload.hangDiagnostics?.isEmpty == false { diagnosticExit(2, UInt64(timestamp)) }
        }
    }
}

@_silgen_name("bilimusic_ios_resolve")
private func resolveTrack(_ request: Int64, _ json: UnsafePointer<CChar>)
@_silgen_name("bilimusic_ios_media_lifecycle")
private func mediaLifecycle(_ backgroundIdle: Bool)
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
    private var mediaSourceInvalidated = false
    private var sleepWork: DispatchWorkItem?
    private var sleepEndsAt: TimeInterval = 0
    private var sleepDeadline: Double = 0
    private var sleepDuration: Double = 0
    private var sleepExpired = false
    private var fullscreenState: (orientation: UIInterfaceOrientation, mask: UIInterfaceOrientationMask, statusHidden: Bool, homeHidden: Bool)?
    private var listeningAt = ProcessInfo.processInfo.systemUptime
    private var listeningActive = false
    private var listeningID: String?
    private var listeningAccount: String?
    private var playbackAccount: String?
    private let engineInstanceId = UUID().uuidString
    private var nativeResolutionPending = false
    private var queueSession: String?
    private var queueVersion: Int64 = 0
    private var queueOwner = ""
    private var retiredQueueOwners = Set<String>()
    private var listeningSession = UUID().uuidString
    private var listeningSeconds: Double = 0
    private var userVolume: Float = 1
    private var outputGain = OutputGain()
    private var outputRamp: DispatchWorkItem?
    private func applyOutput(smooth: Bool = false) {
        outputRamp?.cancel();outputRamp=nil
        outputGain.transition(ProcessInfo.processInfo.systemUptime*1000,smooth:smooth)
        let media=player
        func tick() {
            guard self.player === media else {return}
            let now=ProcessInfo.processInfo.systemUptime*1000
            media.volume=self.outputGain.level(self.userVolume,now)
            if self.outputGain.active(now) {
                let work=DispatchWorkItem { [weak self] in guard self != nil else{return};tick() }
                self.outputRamp=work;DispatchQueue.main.asyncAfter(deadline:.now()+0.02,execute:work)
            } else {self.outputRamp=nil}
        }
        tick()
    }
    private var player = AVPlayer()
    private var standbyPlayer = AVPlayer()
    private lazy var systemMedia = SystemMediaSession(players: [player, standbyPlayer])
    private var carAudioRoute = false
    private var sourceCandidate: AVPlayer?
    private var sourceSwitchRevision: UInt64 = 0
    private var sourceStatus: NSKeyValueObservation?
    private var sourcePlayerStatus: NSKeyValueObservation?
    private var sourceTimeout: DispatchWorkItem?
    private var pendingUpgrade: URL?
    private var upgradeAfterPosition: Double = 0
    private var sourceReply: ((String?) -> Void)?
    private var state = PlayerSnapshot()
    private var tracks: [QueueTrack] = []
    private var entryOrigins: [String:[String]] = [:]
    private var offlineOnly = false
    private var entryOrder: [String] = []
    private var expandedEntries: [String: [QueueTrack]] = [:]
    private var collectionRef: String?
    private var positionSavedAt: TimeInterval = 0
    private var didFinishTrack = false
    private var listeners: [UInt64: Channel] = [:]
    private var repeatMode = "off"
    private let shuffleDeck = ShuffleDeck()
    private var shuffled = false
    private var autoResume = true
    private var resumeThresholdSeconds: Double = 0
    private var collectionPlayback = false
    private var generation: Int64 = 0
    private var profile = ""
    private var playbackRate: Float = 1
    private var desiredPlaying = false
    private var startPosition: Double = 0
    private var initialSeekPending = false
    private var interruptionResume = InterruptionResume()
    private var playbackRecovery = PlaybackRecovery()
    private var recoveryResumePolicy: AutomaticResumePolicy?
    private var pausedAt: TimeInterval?
    private var recoveryAttempted = false
    private var backgroundedAt: TimeInterval?
    private var backgroundPlaybackWanted = false
    private var playbackWatchdog: DispatchWorkItem?
    private var itemStatus: NSKeyValueObservation?
    private var timeStatus: NSKeyValueObservation?
    private var timeObserver: Any?
    private var notifications: [NSObjectProtocol] = []
    private var remoteTargets: [(MPRemoteCommand, Any)] = []
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var interruptionTask: UIBackgroundTaskIdentifier = .invalid
    private var interruptionTimer: DispatchSourceTimer?
    private var interruptedByOtherMedia = false
    private let notificationLyrics = NotificationLyrics()
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
    private var lastNowPlayingLyric: String?

    override func load(webview: WKWebView) {
        if #available(iOS 14.0, *) { _ = PlaybackMetricSubscriber.registered }
        self.webview = webview
        applyWindowTheme(preference: storedThemePreference())
        activePlayer = self
        webview.scrollView.contentInsetAdjustmentBehavior = .never
        webview.scrollView.bounces = false
        webview.scrollView.minimumZoomScale = 1
        webview.scrollView.maximumZoomScale = 1
        webview.scrollView.pinchGestureRecognizer?.isEnabled = false
        player.automaticallyWaitsToMinimizeStalling = true
        observePlayer()
        let center = NotificationCenter.default
        for event in [UIResponder.keyboardWillChangeFrameNotification, UIResponder.keyboardDidChangeFrameNotification] {
            notifications.append(center.addObserver(forName: event, object: nil, queue: .main) { [weak self] note in
                guard let view = self?.webview, let window = view.window,
                      let screenFrame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
                let frame = view.convert(window.convert(screenFrame, from: window.screen.coordinateSpace), from: window)
                let overlap = frame.maxY >= view.bounds.maxY - 1 ? max(0, view.bounds.maxY - frame.minY) : 0
                view.evaluateJavaScript("document.documentElement.style.setProperty('--native-keyboard','\(overlap)px'); document.documentElement.style.setProperty('--native-layout-height','\(view.bounds.height)px'); window.dispatchEvent(new Event('bilimusic-keyboard'));")
            })
        }
        notifications.append(center.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: nil, queue: .main) { [weak self] note in
            guard let self = self, let item = note.object as? AVPlayerItem, item === self.player.currentItem else { return }
            self.advance(1, ended: true)
        })
        notifications.append(center.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: nil, queue: .main) { [weak self] note in
            guard let self = self, let item = note.object as? AVPlayerItem, item === self.player.currentItem else { return }
            self.playbackFailed()
        })
        observeAudioInterruptions(center)
        notifications.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            guard let self else { return }
            self.refreshAudioRoute()
            if (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue { self.pause() }
            if self.desiredPlaying { self.systemMedia.activateIfEligible() }
            self.nowPlaying()
        })
        notifications.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.returnedToForeground() })
        notifications.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.backgroundedAt = ProcessInfo.processInfo.systemUptime
            self.backgroundPlaybackWanted = self.desiredPlaying
            self.accountListening(flush: true); self.savePosition(force: true)
        })
        notifications.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.holdForInterruptionEnd()
            self?.parkMediaIfIdle()
        })
        bindRemoteCommands()
    }
    deinit {
        outputRamp?.cancel()
        playbackWatchdog?.cancel()
        interruptionTimer?.cancel()
        if let observer = timeObserver { player.removeTimeObserver(observer) }
        notifications.forEach { NotificationCenter.default.removeObserver($0) }
        remoteTargets.forEach { $0.0.removeTarget($0.1) }
    }

    private func observePlayer() {
        timeStatus = player.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
            DispatchQueue.main.async {
                guard let self, self.player === player else { return }
                if self.desiredPlaying && player.timeControlStatus == .playing { self.systemMedia.activateIfEligible() }
                self.refresh()
            }
        }
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] _ in self?.refresh() }
    }
    private func cancelSourceSwitch(_ message: String? = "音质切换已取消") {
        sourceSwitchRevision &+= 1
        sourceTimeout?.cancel(); sourceTimeout=nil; sourceStatus=nil; sourcePlayerStatus=nil
        let candidate = sourceCandidate, reply = sourceReply
        sourceCandidate=nil; sourceReply=nil
        candidate?.cancelPendingPrerolls()
        candidate?.pause()
        candidate?.replaceCurrentItem(with:nil)
        reply?(message)
    }
    private func switchSource(_ url:URL, gainDb:Double? = nil, completion:@escaping (String?)->Void) {
        pendingUpgrade=nil
        cancelSourceSwitch()
        let request=generation, id=state.id, original=player, seek=seekRevision, sourceRevision=sourceSwitchRevision
        let candidate=standbyPlayer
        candidate.volume=0; candidate.isMuted=true; candidate.automaticallyWaitsToMinimizeStalling=true
        let item=AVPlayerItem(url:url)
        item.preferredForwardBufferDuration=2
        candidate.replaceCurrentItem(with: item)
        sourceCandidate=candidate;sourceReply=completion
        let timeout=DispatchWorkItem { [weak self,weak candidate] in guard let self, self.sourceSwitchRevision == sourceRevision, self.sourceCandidate === candidate else { return };self.cancelSourceSwitch("新音源准备超时，已保留原音质") }
        sourceTimeout=timeout;DispatchQueue.main.asyncAfter(deadline:.now()+12,execute:timeout)
        var preparing = false
        let prepare = { [weak self, weak candidate, weak item] in
            // Initial KVO callbacks may be synchronous. Queue work until both
            // observations have been retained and revalidate the source on main.
            DispatchQueue.main.async {
                guard let self, let candidate, let item, self.sourceSwitchRevision == sourceRevision, self.sourceCandidate === candidate else { return }
                guard self.generation == request, self.state.id == id, self.player === original,
                      self.seekRevision == seek else { self.cancelSourceSwitch(); return }
                if item.status == .failed || candidate.status == .failed {
                    self.cancelSourceSwitch("新音源无法播放，已保留原音质")
                    return
                }
                guard !preparing, item.status == .readyToPlay, candidate.status == .readyToPlay else { return }
                preparing = true
                let currentPosition = original.currentTime().seconds
                let position = currentPosition.isFinite ? currentPosition : self.state.position
                candidate.seek(to: CMTime(seconds: max(0, position), preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self, weak candidate] ok in
                    self?.onMain { [weak self, weak candidate] in
                        guard let self, let candidate, self.sourceSwitchRevision == sourceRevision, self.sourceCandidate === candidate else { return }
                        guard ok, self.generation == request, self.seekRevision == seek,
                              self.player === original, candidate.status == .readyToPlay, candidate.rate == 0 else {
                            self.cancelSourceSwitch("新音源准备失败，已保留原音质")
                            return
                        }
                        candidate.preroll(atRate: self.playbackRate) { [weak self, weak candidate] ready in
                            self?.onMain { [weak self, weak candidate] in
                                guard let self, let candidate, self.sourceSwitchRevision == sourceRevision, self.sourceCandidate === candidate else { return }
                                guard ready, self.generation == request, self.seekRevision == seek, self.player === original else {
                                    self.cancelSourceSwitch("音质切换已取消，已保留原音质")
                                    return
                                }
                                guard candidate.status == .readyToPlay, let item = candidate.currentItem, item.status == .readyToPlay else {
                                    self.cancelSourceSwitch("新音源不可用，已保留原音质")
                                    return
                                }
                                func alignAndHandoff(_ aligned: Bool) {
                                    guard self.sourceSwitchRevision == sourceRevision,
                                          self.sourceCandidate === candidate else { return }
                                    guard aligned, self.generation == request, self.seekRevision == seek,
                                          self.player === original, candidate.status == .readyToPlay,
                                          item.status == .readyToPlay else {
                                        self.cancelSourceSwitch("新音源定位失败，已保留原音质")
                                        return
                                    }
                                    let position = original.currentTime()
                                    if position.seconds.isFinite,
                                       abs(position.seconds - candidate.currentTime().seconds) > 0.25 {
                                        candidate.seek(to: position, toleranceBefore: .zero, toleranceAfter: .zero) { ready in
                                            self.onMain { alignAndHandoff(ready) }
                                        }
                                        return
                                    }
                                    self.handoffSource(item, from: candidate, gainDb: gainDb)
                                }
                                alignAndHandoff(true)
                            }
                        }
                    }
                }
            }
        }
        sourceStatus = item.observe(\.status, options:[.initial,.new]) { _,_ in prepare() }
        sourcePlayerStatus = candidate.observe(\.status, options:[.initial,.new]) { _,_ in prepare() }
    }

    private func handoffSource(_ item: AVPlayerItem, from candidate: AVPlayer, gainDb: Double?) {
        accountListening(flush: true)
        cancelPlaybackWatchdog()
        let original=player
        if let observer = timeObserver { original.removeTimeObserver(observer); timeObserver = nil }
        timeStatus=nil; itemStatus=nil; sourceStatus=nil; sourcePlayerStatus=nil
        sourceTimeout?.cancel(); sourceTimeout=nil; sourceCandidate=nil
        let reply=sourceReply; sourceReply=nil
        // The session binds both playback slots up front. Removing players from
        // a manually published session can throw an iOS 27 MediaPlayer KVO
        // exception, while an AVPlayerItem cannot be moved to another player.
        original.pause()
        original.replaceCurrentItem(with: nil)
        player=candidate; standbyPlayer=original
        generation+=1; state.revision=generation; seekPending=false
        initialSeekPending=false; lastMediaPosition = -1; hasMediaAdvanced=false
        let request = generation
        observePlayer()
        itemStatus = item.observe(\.status, options:[.new]) { [weak self] item,_ in
            self?.onMain { [weak self] in
                guard let self, self.generation == request, item === self.player.currentItem else { return }
                if item.status == .failed { self.playbackFailed() }
            }
        }
        if let gainDb { outputGain.plan(gainDb) }
        applyOutput(); candidate.isMuted=false
        if desiredPlaying { candidate.rate=playbackRate; watchPlayback() }
        refresh(); nowPlaying()
        reply?(nil)
    }

    @objc public func play(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(PlayArgs.self)
        onMain { [self] in
            guard let url = localMediaURL(args.url), args.position?.isFinite != false, args.volume?.isFinite != false else { invoke.reject("无效的本机音频地址"); return }
            if outputGain.configure(args.loudnessEnabled ?? false,args.loudnessRevision ?? 0) {applyOutput(smooth:true)}
            if args.seamless == true, state.id == args.id, player.currentItem != nil { switchSource(url,gainDb:args.loudnessGainDb ?? 0) { message in if let message {invoke.reject(message)}else{invoke.resolve()} };return }
            cancelSourceSwitch()
            accountListening(flush: true)
            guard state.id == args.id else { invoke.reject("歌曲已切换"); return }
            beginPlaybackDiagnostic(args.diagnosticId)
            savePosition(force: true)
            playbackAccount = args.accountSession ?? queueSession
            collectionRef = args.collectionRef
            cancelPlaybackWatchdog()
            backgroundPlaybackWanted = false
            recoveryAttempted = false; pausedAt = nil
            playbackRate = Float(min(2, max(0.75, args.rate ?? 1)))
            generation += 1; seekPending = false; hasMediaAdvanced = false; lastMediaPosition = -1; state.revision = generation
            if shuffled { shuffleDeck.observe(shuffleItems(),args.id) }
            let suppliedTrack = args.track?.id == args.id ? args.track : nil
            let preparedTrack = state.track?.id == args.id ? state.track : nil
            state.track = tracks.first { $0.id == args.id } ?? suppliedTrack ?? preparedTrack
            prepareArtwork(for: state.track)
            state.duration = state.track?.durationSeconds ?? 0
            userVolume = Float(min(1, max(0, args.volume ?? 1)))
            outputGain.plan(args.loudnessGainDb ?? 0)
            do { try start(url, at: max(0, args.position ?? 0), autoplay: args.playing ?? true, upgrade:args.upgradeUrl.flatMap(localMediaURL), automaticResume:args.automaticResume); invoke.resolve() }
            catch {
                let code = mediaErrorCode(error as NSError)
                fail("无法启动音频，请重新播放", code: code)
                invoke.reject("无法启动音频，请重新播放", code: code)
            }
        }
    }
    @objc public func queue(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(QueueArgs.self)
        onMain { [self] in
            let owner = args.owner ?? "legacy"
            if retiredQueueOwners.contains(owner) { invoke.resolve(); return }
            let version = args.version ?? (owner == queueOwner ? queueVersion + 1 : 1)
            guard owner != queueOwner || version > queueVersion else { invoke.resolve(); return }
            guard args.tracks.count <= 10000, ["off", "one", "all"].contains(args.repeatMode) else { invoke.reject("无效的播放队列"); return }
            let replacedOwner = owner != queueOwner || queueSession != args.accountSession
            if owner != queueOwner { if !queueOwner.isEmpty {retiredQueueOwners.insert(queueOwner)}; queueOwner=owner }
            if queueSession != args.accountSession { expandedEntries = [:] }
            if queueSession != args.accountSession || shuffled != args.shuffled { shuffleDeck.reset() }
            queueVersion=version; queueSession=args.accountSession
            var seen = Set<String>()
            expandedEntries = expandedEntries.filter { key, _ in args.tracks.contains { $0.id == key && $0.resolveParts == true } }
            tracks = args.tracks.flatMap { track in
                if track.resolveParts == true, let parts = expandedEntries[track.id] { return parts }
                return [track]
            }.filter { seen.insert($0.id).inserted }
            if nativeResolutionPending && (replacedOwner || !tracks.contains(where: { $0.id == state.id })) { pause() }
            repeatMode = args.repeatMode; shuffled = args.shuffled; autoResume = args.autoResume ?? true
            resumeThresholdSeconds = args.resumeThresholdSeconds ?? 0
            entryOrigins = args.entryOrigins ?? [:]
            offlineOnly = args.offlineOnly ?? false
            entryOrder = (args.entryOrder ?? args.tracks.map(\.id)).flatMap { expandedEntries[$0]?.map(\.id) ?? [$0] }
            for (id,parts) in expandedEntries {for part in parts where entryOrigins[part.id]==nil {entryOrigins[part.id]=entryOrigins[id] ?? []}}
            collectionPlayback = args.collectionPlayback ?? false
            if let track = tracks.first(where: { $0.id == state.id }) { state.track = track; prepareArtwork(for: track) }
            nowPlaying()
            invoke.resolve()
        }
    }
    @objc public func control(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ControlArgs.self)
        onMain { [self] in
            switch args.action {
            case "prepare":
                pendingUpgrade=nil;cancelSourceSwitch();cancelInterruptionResume()
                playbackRecovery.prepare(policy: nil); recoveryResumePolicy = nil
                cancelPlaybackWatchdog()
                backgroundPlaybackWanted = false
                recoveryAttempted = false; pausedAt = nil
                savePosition(force: true)
                accountListening(flush: true)
                listeningSession = UUID().uuidString
                guard let raw = currentProfile() else { invoke.reject("无法读取当前播放账号，请重新播放", code: "profile_unavailable"); return }
                profile = String(cString: raw); freeProfile(raw)
                playbackAccount = nil
                generation += 1; seekPending = false; hasMediaAdvanced = false; lastMediaPosition = -1; desiredPlaying = false; itemStatus = nil
                player.pause(); player.replaceCurrentItem(with: nil)
                endBackgroundTask()
                let track = args.track?.id == args.id ? args.track : nil
                state = PlayerSnapshot(id: args.id, status: "buffering", duration: track?.durationSeconds ?? 0, track: track, revision: generation)
                prepareArtwork(for: track)
                publish()
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
            case "next": advance(1)
            case "previous": advance(-1)
            case "pause": pause()
            case "resume": resume()
            case "seek": seek(args.value ?? 0)
            case "rate":
                if let value = args.value, value.isFinite, (0.75...2).contains(value) {
                    playbackRate = Float(value)
                    if desiredPlaying && !initialSeekPending && player.currentItem?.status == .readyToPlay {
                        player.rate = playbackRate
                    }
                    refresh()
                    nowPlaying()
                }
            case "loudness": if outputGain.configure((args.value ?? 0)>0,args.settingsRevision ?? 0) {applyOutput(smooth:true)}
            case "volume": userVolume = Float(min(1, max(0, args.value ?? Double(userVolume))));applyOutput()
            case "theme":
                let preference = args.theme ?? (args.value == 1 ? "light" : "dark")
                let normalized = ["light", "dark", "system"].contains(preference) ? preference : "dark"
                UserDefaults.standard.set(normalized, forKey: Self.themePreferenceKey)
                applyWindowTheme(preference: normalized)
            case "immersive": break
            case "videoFullscreen": setVideoFullscreen(args.value == 1)
            default: invoke.reject("不支持的播放操作"); return
            }
            invoke.resolve()
        }
    }
    private static let themePreferenceKey = "bilimusic-theme-preference"
    /// Resolved against the window's current interface style, so native chrome
    /// follows the OS while the window is not pinned to light or dark.
    private static let themeBackground = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 7/255, green: 16/255, blue: 25/255, alpha: 1)
            : UIColor(red: 244/255, green: 246/255, blue: 250/255, alpha: 1)
    }

    /// New builds store the preference so `system` survives a cold launch;
    /// older builds only stored the resolved colour as a Bool.
    private func storedThemePreference() -> String {
        if let stored = UserDefaults.standard.string(forKey: Self.themePreferenceKey),
           ["light", "dark", "system"].contains(stored) { return stored }
        return UserDefaults.standard.bool(forKey: "bilimusic-light-window") ? "light" : "dark"
    }

    private func applyWindowTheme(preference: String) {
        let color = Self.themeBackground
        switch preference {
        case "light": webview?.window?.overrideUserInterfaceStyle = .light
        // Hand the window back so WKWebView's prefers-color-scheme reports the
        // OS scheme again; the dynamic colours then track appearance changes.
        case "system": webview?.window?.overrideUserInterfaceStyle = .unspecified
        default: webview?.window?.overrideUserInterfaceStyle = .dark
        }
        webview?.window?.backgroundColor = color
        webview?.isOpaque = false
        webview?.backgroundColor = color
        webview?.scrollView.backgroundColor = color
        if #available(iOS 15.0, *) { webview?.underPageBackgroundColor = color }
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

    @objc public func lyrics(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(LyricsArgs.self)
        guard args.data.utf8.count <= 48 * 1024 * 1024, let data=args.data.data(using:.utf8), let request=try? JSONDecoder().decode(NativeLyricsRequest.self,from:data) else { invoke.reject("歌词内容无效");return }
        onMain { [self] in
            if request.action == "subtitle-preference" {
                notificationLyrics.setSubtitlePreference(enabled: request.enabled == true, language: request.language ?? "")
                nowPlaying()
            } else if request.action == "update" {
                notificationLyrics.update(request)
                nowPlaying()
            }
            invoke.resolve(LyricsCapability())
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
    @objc public func diagnostic_environment(_ invoke: Invoke) {
        onMain {
            let device = UIDevice.current
            invoke.resolve([
                "osName": device.userInterfaceIdiom == .pad ? "iPadOS" : "iOS",
                "osVersion": device.systemVersion,
                "deviceModel": device.model,
            ])
        }
    }

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
        validatedLocalMediaURL(value)
    }
    private func activate() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default, options: [])
        try session.setActive(true)
        refreshAudioRoute()
    }
    private func refreshAudioRoute() {
        // Headphones and speakers also use generic Bluetooth ports.
        carAudioRoute = AVAudioSession.sharedInstance().currentRoute.outputs.contains { $0.portType == .carAudio }
    }
    private func start(_ url: URL, at position: Double = 0, autoplay: Bool = true, upgrade: URL? = nil, automaticResume: AutomaticResumePolicy? = nil) throws {
        playbackRecovery.prepare(policy: automaticResume)
        cancelSourceSwitch()
        pendingUpgrade=upgrade;upgradeAfterPosition=position+0.75
        cancelPlaybackWatchdog()
        didFinishTrack = false
        positionSavedAt = ProcessInfo.processInfo.systemUptime - 15
        accountListening(flush: true)
        try activate(); desiredPlaying = autoplay
        state.error = nil; state.errorCode = nil; state.stopped = false; state.status = autoplay ? "buffering" : "paused"; state.position = 0; startPosition = position; initialSeekPending = position > 0
        mediaSourceInvalidated = false
        NSLog("BiliMusic audio start: host=%@ port=%ld position=%.3f", url.host ?? "", url.port ?? 0, position)
        let item = AVPlayerItem(url: url); item.preferredForwardBufferDuration = 2
        itemStatus = nil; player.replaceCurrentItem(with: item);applyOutput()
        let request = generation
        var positioned = false
        itemStatus = item.observe(\.status, options: [.new, .initial]) { [weak self] item, _ in
            DispatchQueue.main.async {
                guard let self = self, self.generation == request, item === self.player.currentItem else { return }
                if item.status == .failed {
                    let error = item.error as NSError?
                    if let error {
                        NSLog("BiliMusic audio item failed: %@ (%ld)", error.domain, error.code)
                        var underlying = error
                        for _ in 0..<4 {
                            if let failedURL = underlying.userInfo[NSURLErrorFailingURLErrorKey] as? URL {
                                NSLog("BiliMusic failing endpoint: host=%@ port=%ld", failedURL.host ?? "", failedURL.port ?? 0)
                            }
                            guard let next = underlying.userInfo[NSUnderlyingErrorKey] as? NSError else { break }
                            NSLog("BiliMusic underlying audio error: %@ (%ld)", next.domain, next.code)
                            underlying = next
                        }
                    }
                    self.playbackFailed()
                    return
                }
                if item.status == .readyToPlay {
                    guard !positioned else { return }; positioned = true
                    let duration = item.duration.seconds
                    if duration.isFinite && duration > 0 { self.state.duration = duration }
                    let position: Double
                    do { position = try playbackStartPosition(self.startPosition, duration: duration, policy: automaticResume) }
                    catch { self.fail(error.localizedDescription, code: "duration_unavailable"); return }
                    self.playbackRecovery.chosePosition()
                    self.startPosition = 0; self.state.position = position
                    self.initialSeekPending = position > 0
                    self.upgradeAfterPosition = position + 0.75
                    if position > 0 {
                        self.state.position = position
                        self.player.seek(to: CMTime(seconds: position, preferredTimescale: 600), toleranceBefore: CMTime(seconds: 0.1, preferredTimescale: 600), toleranceAfter: CMTime(seconds: 0.1, preferredTimescale: 600)) { [weak self] completed in
                            self?.onMain { [weak self] in
                                guard let self, self.generation == request, item === self.player.currentItem else { return }
                                self.initialSeekPending = false
                                self.playbackRecovery.completedSeek(completed)
                                if !completed { self.playbackFailed(); return }
                                if self.desiredPlaying { self.player.rate = self.playbackRate }
                                self.refresh()
                            }
                        }
                    } else {
                        if self.desiredPlaying && self.player.timeControlStatus != .playing { self.player.rate = self.playbackRate }
                        self.refresh()
                    }
                }
            }
        }
        if autoplay { watchPlayback() }
        if autoplay && position == 0 { player.rate = playbackRate } else { player.pause() }; accountListening(); publish()
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
    private func pause(interrupted: Bool = false) {
        nativeResolutionPending = false
        cancelPlaybackWatchdog()
        backgroundPlaybackWanted = false
        if pausedAt == nil { pausedAt = Date().timeIntervalSince1970 }
        savePosition(force: true)
        accountListening(flush: true)
        if !interrupted { cancelInterruptionResume() }
        desiredPlaying = false
        if state.stopped { generation += 1; seekPending = false; hasMediaAdvanced = false; lastMediaPosition = -1; state.revision = generation }
        player.pause(); state.status = "paused"; endBackgroundTask(); publish()
        parkMediaIfIdle()
    }
    private func parkMediaIfIdle() {
        // An interruption is not a user pause. Keep the prepared item and its
        // local source usable for a resumption event while still backgrounded.
        guard !desiredPlaying, UIApplication.shared.applicationState == .background,
              interruptionResume.mayParkMedia else { return }
        mediaSourceInvalidated = true
        mediaLifecycle(true)
    }
    private func resume(audioSessionActive: Bool = false) {
        interruptionResume.cancel()
        defer { endInterruptionTask() }
        if expireSleepIfNeeded() { return }
        if desiredPlaying && state.status == "buffering" && state.stopped { return }
        recoveryAttempted = false
        backgroundPlaybackWanted = false
        let stale = pausedAt.map { Date().timeIntervalSince1970 - $0 >= 120 } ?? false
        pausedAt = nil
        if mediaSourceInvalidated || player.currentItem?.status == .failed || state.error != nil || stale || playbackRecovery.seekFailed {
            if recoverCurrentPlayback() { return }
        }
        guard player.currentItem != nil else {
            if let track = state.track ?? tracks.first(where: { $0.id == state.id }) { resolve(track) }; return
        }
        do {
            if !audioSessionActive { try activate() }
            let position = player.currentTime().seconds
            if state.duration > 0 && position.isFinite && position >= state.duration - 0.25 { seek(0) }
            desiredPlaying = true; player.rate = playbackRate; watchPlayback(); refresh()
        } catch { fail("无法恢复播放") }
    }
    @discardableResult
    private func recoverCurrentPlayback() -> Bool {
        guard !recoveryAttempted, let track = state.track ?? tracks.first(where: { $0.id == state.id }) else { return false }
        let current = player.currentTime().seconds
        let position = playbackRecovery.position(current: current, saved: state.position, requested: startPosition, initialPending: initialSeekPending || seekPending)
        recoveryResumePolicy = playbackRecovery.automaticResume
        recoveryAttempted = true
        resolve(track, refresh: true, position: position)
        return true
    }
    private func playbackFailed() {
        if expireSleepIfNeeded() { return }
        // Failed requests belonging to an intentionally paused item must not
        // become a playback error or start a new source in the background.
        guard desiredPlaying else {
            cancelPlaybackWatchdog()
            refresh()
            return
        }
        // Recreate failed items natively so lock-screen playback recovers while
        // the WebView is suspended. One refresh is allowed per user attempt.
        if diagnosticInitialError == nil {
            diagnosticInitialError = player.currentItem?.error.map { mediaErrorCode($0 as NSError) } ?? "audio_stalled"
        }
        if desiredPlaying && recoverCurrentPlayback() { return }
        if player.currentItem?.status == .failed {
            fail("音频加载失败，请重新播放", code: player.currentItem?.error.map { mediaErrorCode($0 as NSError) } ?? "audio_prepare_failed")
        } else {
            fail("音频缓冲超时，请检查网络后重试", code: "audio_stalled")
        }
    }
    private func cancelPlaybackWatchdog() {
        playbackWatchdog?.cancel()
        playbackWatchdog = nil
    }
    private func watchPlayback() {
        // The periodic refresh must not postpone this deadline indefinitely.
        guard playbackWatchdog == nil, desiredPlaying else { return }
        let request = generation
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.generation == request else { return }
            self.playbackWatchdog = nil
            guard self.desiredPlaying, self.player.timeControlStatus != .playing || ProcessInfo.processInfo.systemUptime - self.lastMediaAdvanceAt >= 1.5 else { return }
            self.playbackFailed()
        }
        playbackWatchdog = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 12, execute: work)
    }
    private var seekRevision = 0
    private var seekPending = false
    private var hasMediaAdvanced = false
    private var lastMediaPosition: Double = -1
    private var lastMediaAdvanceAt = ProcessInfo.processInfo.systemUptime
    private var publishSequence: Int64 = 0
    private func seek(_ seconds: Double, completion: (() -> Void)? = nil) {
        accountListening(flush: true)
        guard seconds.isFinite else { completion?();return }
        didFinishTrack = false
        let target = max(0, min(seconds, state.duration > 0 ? state.duration : seconds))
        seekRevision += 1
        seekPending = true
        playbackRecovery.completedSeek(true)
        hasMediaAdvanced = false
        state.seekRevision = seekRevision
        state.advancing = false
        let revision = seekRevision
        let item = player.currentItem
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] completed in
            guard let self else { completion?();return }
            self.onMain { [weak self] in
                defer { completion?() }
                guard let self, self.seekRevision == revision, self.player.currentItem === item else { return }
                self.seekPending = false
                self.playbackRecovery.completedSeek(completed)
                guard completed else { self.playbackFailed(); return }
                self.lastMediaAdvanceAt = ProcessInfo.processInfo.systemUptime
                self.lastMediaPosition = self.player.currentTime().seconds
                self.savePosition(force: true)
                self.refresh()
            }
        }
        state.position = target; publish()
    }
    private func stop() {
        nativeResolutionPending = false
        pendingUpgrade=nil;cancelSourceSwitch()
        notificationLyrics.clear();lastNowPlayingLyric=nil
        cancelPlaybackWatchdog()
        backgroundPlaybackWanted = false
        backgroundedAt = nil
        pausedAt = nil; recoveryAttempted = false
        clearSleep()
        savePosition(force: true)
        accountListening(flush: true)
        cancelInterruptionResume()
        playbackRecovery.prepare(policy: nil); recoveryResumePolicy = nil
        generation += 1; seekPending = false; hasMediaAdvanced = false; lastMediaPosition = -1; desiredPlaying = false; itemStatus = nil
        player.pause(); player.replaceCurrentItem(with: nil)
        shuffleDeck.reset()
        state = PlayerSnapshot(revision: generation); tracks = []; expandedEntries = [:]; endBackgroundTask()
        artworkTask?.cancel(); artworkTask = nil; artworkURL = nil; artwork = nil
        systemMedia.info.nowPlayingInfo = nil
        updateRemoteTrackCommands()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        publish()
    }
    private func mediaErrorCode(_ error: NSError) -> String {
        var cause = error
        for _ in 0..<4 {
            if cause.domain == NSURLErrorDomain { break }
            guard let underlying = cause.userInfo[NSUnderlyingErrorKey] as? NSError else { break }
            cause = underlying
        }
        let domains = [NSURLErrorDomain, NSOSStatusErrorDomain, NSPOSIXErrorDomain, AVFoundationErrorDomain, "CoreMediaErrorDomain"]
        let domain = domains.contains(cause.domain) ? cause.domain : "other"
        return "ios_media:\(domain):\(cause.code)"
    }
    private var diagnosticOwner: String?
    private var diagnosticAccount: String?
    private var diagnosticStarted = ProcessInfo.processInfo.systemUptime
    private var diagnosticPlaying = false
    private var diagnosticPrepared = false
    private var diagnosticInitialError: String?

    private func beginPlaybackDiagnostic(_ id: String?) {
        state.diagnosticId = id ?? UUID().uuidString
        diagnosticOwner = profile
        diagnosticAccount = queueSession
        diagnosticStarted = ProcessInfo.processInfo.systemUptime
        diagnosticPlaying = false
        diagnosticPrepared = false
        diagnosticInitialError = nil
    }

    private func playbackDiagnostic(_ step: String, _ outcome: String, code: String? = nil) {
        guard let operation = state.diagnosticId, let owner = diagnosticOwner, let session = diagnosticAccount,
              let track = state.track else { return }
        var event: [String: Any] = [
            "operation": operation, "area": "playback", "step": step, "outcome": outcome,
            "engine": "av-player", "bvid": track.source.bvid, "cid": track.source.cid,
            "elapsedMs": Int(max(0, ProcessInfo.processInfo.systemUptime - diagnosticStarted) * 1000),
        ]
        if let code { event["code"] = code }
        if let diagnosticInitialError { event["initialCode"] = diagnosticInitialError }
        let payload: [String: Any] = ["kind": "diagnostic", "profile": owner, "accountSession": session, "event": event]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        json.withCString { resolveTrack(0, $0) }
    }

    private func fail(_ message: String, code: String? = nil) {
        nativeResolutionPending = false
        pendingUpgrade=nil;cancelSourceSwitch()
        cancelPlaybackWatchdog()
        accountListening(flush: true)
        cancelInterruptionResume()
        playbackDiagnostic(nativeResolutionPending ? "source" : (diagnosticPlaying ? "control" : "start"), "failed", code: code)
        if recoveryAttempted && !diagnosticPlaying { playbackDiagnostic("recovery", "failed", code: code) }
        desiredPlaying = false; player.pause(); state.status = "error"; state.error = message; state.errorCode = code; endBackgroundTask(); publish()
    }
    private func accountListening(flush: Bool = false) {
        let now = ProcessInfo.processInfo.systemUptime
        if listeningActive { listeningSeconds += max(0, min(300, now - listeningAt)) }
        listeningAt = now
        if flush || listeningID != state.id || listeningAccount != playbackAccount || listeningSeconds >= 15 {
            if let id = listeningID, let account = listeningAccount, listeningSeconds > 0, let data = try? JSONSerialization.data(withJSONObject: ["accountSession": account, "id": id, "seconds": min(300, listeningSeconds), "observedAt": Int64(Date().timeIntervalSince1970 * 1000), "sessionId": listeningSession]), let json = String(data: data, encoding: .utf8) { json.withCString { recordNativeListening($0) } }
            listeningSeconds = 0
        }
        listeningID = state.id; listeningAccount = playbackAccount
        listeningActive = player.timeControlStatus == .playing
    }
    private func savePosition(force: Bool = false, completed: Bool = false) {
        guard let id = state.id, let account = playbackAccount, player.currentItem?.status == .readyToPlay, !initialSeekPending, !seekPending, !playbackRecovery.seekFailed else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if !force && now - positionSavedAt < 15 { return }
        let position = player.currentTime().seconds
        guard position.isFinite else { return }
        let duration = state.duration
        let saved = completed || didFinishTrack || position < 1 || (duration > 0 && position >= duration - 1) ? 0 : position
        positionSavedAt = now
        let millis = Int64(Date().timeIntervalSince1970 * 1000)
        var sample: [String: Any] = ["accountSession": account, "id": id, "position": saved, "observedAt": millis]
        if let collectionRef { sample["collectionRef"] = collectionRef }
        if let data = try? JSONSerialization.data(withJSONObject: sample),
           let json = String(data: data, encoding: .utf8) { json.withCString { recordNativeListening($0) } }
    }
    private func refresh() {
        if expireSleepIfNeeded() { return }
        let now = ProcessInfo.processInfo.systemUptime
        let position = player.currentTime().seconds
        if position.isFinite && lastMediaPosition >= 0 && position > lastMediaPosition + 0.01 && !seekPending && !initialSeekPending {
            hasMediaAdvanced = true
            lastMediaAdvanceAt = now
        }
        if position.isFinite { lastMediaPosition = position }
        state.advancing = hasMediaAdvanced && desiredPlaying && !seekPending && !initialSeekPending && player.timeControlStatus == .playing && now - lastMediaAdvanceAt < 1.5
        if state.advancing {
            cancelPlaybackWatchdog(); endBackgroundTask()
        } else if desiredPlaying && !state.stopped && state.error == nil {
            // A stream can stall again long after its startup timer was cancelled.
            watchPlayback()
        }
        if let item = player.currentItem {
            let position = player.currentTime().seconds, duration = item.duration.seconds
            if position.isFinite && !initialSeekPending && !seekPending && !playbackRecovery.seekFailed && item.status != .failed { state.position = max(0, position) }
            if duration.isFinite && duration > 0 { state.duration = duration }
            if desiredPlaying && player.timeControlStatus == .playing { savePosition() }
            if state.error == nil { state.status = desiredPlaying ? (state.advancing ? "playing" : "buffering") : "paused" }
        }
        if state.advancing, state.position >= upgradeAfterPosition, let upgrade=pendingUpgrade, sourceCandidate == nil {
            pendingUpgrade=nil
            switchSource(upgrade) { _ in /* Keep the initial stream on failure. */ }
        }
        publish()
    }
    private func publish() {
        if player.currentItem?.status == .readyToPlay && !diagnosticPrepared {
            diagnosticPrepared = true
            playbackDiagnostic("media-ready", "succeeded")
        }
        if state.status == "playing" && !diagnosticPlaying {
            diagnosticPlaying = true
            playbackDiagnostic("start", "succeeded")
            if recoveryAttempted { playbackDiagnostic("recovery", "succeeded") }
        }
        publishSequence += 1
        state.sequence = publishSequence
        state.engineInstanceId = engineInstanceId
        state.sessionId = listeningSession
        state.sourceRevision = generation
        state.autonomousQueue = !tracks.isEmpty
        state.capabilities.autonomousQueue = state.autonomousQueue
        state.queueVersion = queueVersion
        state.floatingLyricsEnabled = false
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
        if currentNotificationLyric() != lastNowPlayingLyric || state.id != lastNowPlayingID || state.status != lastNowPlayingStatus || abs(state.position - lastNowPlayingPosition) > 5 || ProcessInfo.processInfo.systemUptime - lastNowPlayingAt > 5 {
            nowPlaying()
        }
    }
    private func currentNotificationLyric() -> String? {
        notificationLyrics.line(for: state.id, at: state.position, carAudio: carAudioRoute)
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
        updateRemoteTrackCommands()
        guard let id = state.id else { return }
        lastNowPlayingAt = ProcessInfo.processInfo.systemUptime
        lastNowPlayingPosition = state.position
        lastNowPlayingStatus = state.status
        lastNowPlayingID = id
        lastNowPlayingLyric = currentNotificationLyric()
        let text = notificationMediaText(title: state.track?.title ?? "BiliMusic", artist: state.track?.artist ?? "歌手未知", lyric: lastNowPlayingLyric)
        var info: [String: Any] = [MPMediaItemPropertyTitle: text.title, MPMediaItemPropertyArtist: text.artist, MPNowPlayingInfoPropertyExternalContentIdentifier: id,
                                  MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue, MPNowPlayingInfoPropertyElapsedPlaybackTime: state.position,
                                  MPNowPlayingInfoPropertyPlaybackRate: state.status == "playing" ? Double(playbackRate) : 0.0,
                                  MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0]
        if let index = tracks.firstIndex(where: { $0.id == id }) {
            info[MPNowPlayingInfoPropertyPlaybackQueueIndex] = index
            info[MPNowPlayingInfoPropertyPlaybackQueueCount] = tracks.count
        }
        if state.duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = state.duration }
        if let album = state.track?.album { info[MPMediaItemPropertyAlbumTitle] = album }
        if let artwork { info[MPMediaItemPropertyArtwork] = artwork }
        systemMedia.info.nowPlayingInfo = info
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
    private func shuffleItems() -> [ShuffleItem] { tracks.map { ShuffleItem(id:$0.id,artist:$0.artist ?? "",bvid:$0.source.bvid) } }
    private func advance(_ direction: Int, ended: Bool = false, restartCurrent: Bool = true) {
        if expireSleepIfNeeded() { return }
        if restartCurrent && direction < 0 && state.position > 4 { seek(0); return }
        guard !tracks.isEmpty else { pause(); return }
        let index = tracks.firstIndex { $0.id == state.id } ?? -1
        if ended { didFinishTrack = true; savePosition(force: true, completed: true) }
        if ended && repeatMode == "one", let track = tracks.first(where:{$0.id==state.id}) { resolve(track, restart: true); return }
        if ended && !shuffled && repeatMode == "off" && index == tracks.count - 1 { pause(); return }
        if shuffled {
            if let id=shuffleDeck.target(shuffleItems(),state.id ?? "",direction),let track=tracks.first(where:{$0.id==id}) { resolve(track) }
        } else if let id=orderedQueueTarget(entryOrder,tracks.map(\.id),state.id ?? "",direction,!ended || repeatMode=="all"),let track=tracks.first(where:{$0.id==id}) { resolve(track) }
        else if ended { pause() }
    }
    private func resolve(_ track: QueueTrack, restart: Bool = false, refresh: Bool = false, position: Double? = nil) {
        guard playbackAccount == nil || playbackAccount == queueSession else {
            fail("播放账号已变更，请重新播放", code: "account_changed"); return
        }
        let account = playbackAccount ?? queueSession
        cancelInterruptionResume()
        if !refresh { recoveryResumePolicy = nil; playbackRecovery.prepare(policy: nil) }
        pendingUpgrade=nil;cancelSourceSwitch()
        cancelPlaybackWatchdog()
        if !refresh { recoveryAttempted = false }
        if state.id != track.id { savePosition(force: true) }
        accountListening(flush: true)
        playbackAccount = account
        if !refresh { listeningSession = UUID().uuidString; beginPlaybackDiagnostic(nil) }
        else {
            diagnosticPlaying = false
            diagnosticPrepared = false
            playbackDiagnostic("recovery", "started")
        }
        generation += 1; seekPending = false; hasMediaAdvanced = false; lastMediaPosition = -1; state.revision = generation; desiredPlaying = true; itemStatus = nil
        player.pause(); player.replaceCurrentItem(with: nil)
        state.id = track.id; state.track = track; state.position = 0; state.duration = track.durationSeconds
        prepareArtwork(for: track)
        state.error = nil; state.errorCode = nil; state.status = "buffering"; state.stopped = true
        endBackgroundTask()
        let request = generation
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "BiliMusic next track") { [weak self] in
            guard let self, self.generation == request, self.desiredPlaying else { return }
            self.fail("后台加载超时，请返回应用继续播放", code: "source_timeout")
        }
        nativeResolutionPending = true
        publish()
        let collection = collectionPlayback || (track.partCount ?? 0) > 1 || track.source.page > 1 || tracks.contains { $0.id != track.id && $0.source.bvid == track.source.bvid }
        guard let data = try? JSONEncoder().encode(ResolveRequest(diagnosticId: state.diagnosticId, initialErrorCode: diagnosticInitialError, offlineOnly: offlineOnly, visibilityScopes:entryOrigins[track.id] ?? [],accountSession:account, profile: profile, track: track, restart: restart, autoResume: autoResume, resumeThresholdSeconds: resumeThresholdSeconds, collectionPlayback: collection, refresh: refresh, position: position, subtitles: notificationLyrics.subtitlesEnabled, subtitleLanguage: notificationLyrics.subtitleLanguage, subtitleRevision: notificationLyrics.subtitleRevision)),
              let json = String(data: data, encoding: .utf8) else { fail("无法读取歌曲信息", code: "invalid_input"); return }
        json.withCString { resolveTrack(generation, $0) }
    }
    fileprivate func resolved(_ request: Int64, _ data: Data) {
        guard request == generation else { return }
        guard let result = try? JSONDecoder().decode(ResolvedTrack.self, from: data) else {
            if nativeResolutionPending && desiredPlaying { fail("无法解析播放地址", code: "invalid_source") }
            return
        }
        if result.kind == "lyrics" {
            if !nativeResolutionPending, result.accountSession == queueSession, let id = result.id, id == state.id, let timeline = result.timeline {
                notificationLyrics.seedBackground(timeline, id: id, revision: result.subtitleRevision)
                nowPlaying()
            }
            return
        }
        guard nativeResolutionPending, desiredPlaying else { return }
        nativeResolutionPending = false
        if result.skip == true, let id=result.entryId {
            let index=tracks.firstIndex(where:{$0.id==id}) ?? 0
            tracks.removeAll(where:{$0.id==id}); expandedEntries[id]=nil
            if tracks.isEmpty || index >= tracks.count && repeatMode != "all" { pause(); endBackgroundTask() } else { resolve(tracks[index >= tracks.count ? 0 : index]) }
            return
        }
        if let error = result.error { fail(error, code: result.errorCode ?? "source_unavailable"); return }
        guard let raw = result.url, let url = localMediaURL(raw) else { fail("无法解析播放地址", code: "invalid_source"); return }
        if let id = result.entryId, let parts = result.parts, !parts.isEmpty,
           let index = tracks.firstIndex(where: { $0.id == id && $0.resolveParts == true }) {
            for part in parts {entryOrigins[part.id]=entryOrigins[id] ?? []}
            expandedEntries[id] = parts
            entryOrder = entryOrder.flatMap { $0 == id ? parts.map(\.id) : [$0] }
            tracks.replaceSubrange(index...index, with: parts)
        }
        if let track = result.track {
            state.id = track.id; state.track = track; state.duration = track.durationSeconds
            notificationLyrics.seed(NativeLyricsRequest(action:"update",id:track.id,lines:result.lyrics?.lines ?? [],biasMs:result.lyrics?.biasMs ?? 0,subtitles:false))
            prepareArtwork(for: track)
        }
        let policy = result.automaticResume ?? recoveryResumePolicy
        recoveryResumePolicy = nil
        outputGain.plan(result.loudnessGainDb ?? 0)
        do { try start(url, at: result.position ?? 0, upgrade:result.upgradeUrl.flatMap(localMediaURL), automaticResume:policy) }
        catch { fail("无法启动音频，请重新播放", code: mediaErrorCode(error as NSError)) }
    }
    private func returnedToForeground() {
        mediaLifecycle(false)
        endInterruptionTask()
        reconcileAudioInterruptionOnReturn()
        let absence = backgroundedAt.map { ProcessInfo.processInfo.systemUptime - $0 } ?? 0
        let wasPlaying = backgroundPlaybackWanted
        backgroundedAt = nil
        backgroundPlaybackWanted = false
        // Sleep expiry, manual pause and account stop all revoke automatic recovery.
        if expireSleepIfNeeded() { return }
        guard state.id != nil, !sleepExpired, pausedAt == nil,
              desiredPlaying || (wasPlaying && state.status == "error") else { refresh(); return }
        // Do not replace a source request already being resolved by Rust.
        if state.stopped && state.status == "buffering" { refresh(); return }
        if player.currentItem?.status == .failed || state.error != nil ||
            (absence >= 2 && player.timeControlStatus != .playing) {
            // One extra recovery per actual foreground transition. Subsequent
            // callbacks use the normal single-attempt budget until a user retry.
            recoveryAttempted = false
            if recoverCurrentPlayback() { return }
        }
        refresh()
    }
    private func endBackgroundTask() {
        if backgroundTask != .invalid { UIApplication.shared.endBackgroundTask(backgroundTask); backgroundTask = .invalid }
    }
    private func reconcileAudioInterruptionOnReturn() {
        guard let token = interruptionResume.foregroundToken else { return }
        let request = generation
        let accountSession = queueSession, queueIdentity = queueOwner
        // Let the outgoing media app finish deactivating its session. This is a
        // one-shot foreground reconciliation, not a background focus poll.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self, UIApplication.shared.applicationState == .active,
                  self.generation == request, self.state.id != nil,
                  self.queueSession == accountSession, self.queueOwner == queueIdentity,
                  !self.desiredPlaying, !self.expireSleepIfNeeded() else { return }
            let session = AVAudioSession.sharedInstance()
            guard self.interruptionResume.canRecoverInForeground(token: token,
                otherAudioPlaying: session.isOtherAudioPlaying || session.secondaryAudioShouldBeSilencedHint) else { return }
            do {
                // Calls and other exclusive sessions may still deny activation
                // even if the audio-playing hint is clear. Do not consume intent
                // or enter a retry loop in that case.
                try self.activate()
                guard self.interruptionResume.finish(allowed: true) else { return }
                NSLog("BiliMusic audio interruption: recovered missing end on foreground")
                self.resume(audioSessionActive: true)
            } catch {
                NSLog("BiliMusic audio interruption: foreground recovery deferred code=%ld", (error as NSError).code)
            }
        }
    }
    private func interrupted(_ note: Notification) {
        guard let value = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt, let type = AVAudioSession.InterruptionType(rawValue: value) else { return }
        if type == .began {
            playbackDiagnostic("audio-focus", "succeeded", code: "transient_loss")
            // A suspension notification is delivered after the app wakes.
            // A real interruption already saved its resume intent.
            let reason = note.userInfo?[AVAudioSessionInterruptionReasonKey] as? UInt ?? 0
            if reason == AVAudioSession.InterruptionReason.appWasSuspended.rawValue {
                if desiredPlaying && player.timeControlStatus != .playing { beginAudioInterruption(); reconcileAudioInterruptionOnReturn() }
                return
            }
            beginAudioInterruption(otherMedia: reason == AVAudioSession.InterruptionReason.default.rawValue)
        } else {
            let options = AVAudioSession.InterruptionOptions(rawValue: note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
            playbackDiagnostic("audio-focus", "succeeded", code: options.contains(.shouldResume) ? "gain" : "action_denied")
            finishAudioInterruption(allowed: options.contains(.shouldResume))
        }
    }
    private func beginAudioInterruption(otherMedia: Bool = false) {
        NSLog("BiliMusic audio interruption: began playing=%d", desiredPlaying)
        interruptedByOtherMedia = otherMedia
        interruptionResume.begin(wasPlaying: desiredPlaying)
        holdForInterruptionEnd()
        pause(interrupted: true)
    }
    private func holdForInterruptionEnd() {
        guard UIApplication.shared.applicationState != .active,
              !interruptionResume.mayParkMedia, interruptionTask == .invalid else { return }
        // Keep the process available for short interruptions using the system's
        // bounded task allowance. The resume intent survives task expiration.
        interruptionTask = UIApplication.shared.beginBackgroundTask(withName: "BiliMusic audio interruption") { [weak self] in
            self?.endInterruptionTask()
        }
        guard interruptionTask != .invalid, interruptedByOtherMedia else { return }
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + .milliseconds(650), repeating: .milliseconds(650), leeway: .milliseconds(100))
        timer.setEventHandler { [weak self] in
            guard let self, self.interruptedByOtherMedia, !self.expireSleepIfNeeded() else { return }
            let session = AVAudioSession.sharedInstance()
            let otherAudio = session.isOtherAudioPlaying || session.secondaryAudioShouldBeSilencedHint
            self.sampleCompetingAudio(isPlaying: otherAudio)
        }
        interruptionTimer = timer
        timer.resume()
    }
    private func sampleCompetingAudio(isPlaying: Bool) {
        if interruptionResume.competingAudioEnded(isPlaying: isPlaying) { reactivateInterruptedAudio() }
    }
    private func endInterruptionTask() {
        interruptionTimer?.cancel()
        interruptionTimer = nil
        if interruptionTask != .invalid {
            UIApplication.shared.endBackgroundTask(interruptionTask)
            interruptionTask = .invalid
        }
    }
    private func cancelInterruptionResume() {
        interruptionResume.cancel()
        endInterruptionTask()
    }
    private func finishAudioInterruption(allowed: Bool) {
        NSLog("BiliMusic audio interruption: ended resumeAllowed=%d", allowed)
        if allowed && !interruptionResume.mayParkMedia { reactivateInterruptedAudio() }
        else {
            cancelInterruptionResume()
            parkMediaIfIdle()
        }
    }
    private func reactivateInterruptedAudio() {
        guard !interruptionResume.mayParkMedia, state.id != nil, !expireSleepIfNeeded() else { return }
        do {
            try activate()
            if interruptionResume.finish(allowed: true) { resume(audioSessionActive: true) }
        } catch {
            // Keep the pending intent if the competing session still owns audio.
            NSLog("BiliMusic audio interruption: activation deferred code=%ld", (error as NSError).code)
        }
    }
    private func observeAudioInterruptions(_ center: NotificationCenter) {
        // Older Xcode SDKs retain the legacy path; runtime deployment stays iOS 15+.
        #if compiler(>=6.4)
        if #available(iOS 27.0, *) {
            notifications.append(center.addObserver(forName: AVAudioSession.didBecomeInactiveNotification, object: nil, queue: .main) { [weak self] note in
                guard let context = note.userInfo?[AVAudioSession.deactivationContextKey] as? AVAudioSession.DeactivationContext,
                      context.source == .system else { return }
                self?.beginAudioInterruption(otherMedia: context.interruptionContext?.reason == .default)
            })
            notifications.append(center.addObserver(forName: AVAudioSession.resumptionRecommendationNotification, object: nil, queue: .main) { [weak self] note in
                guard let context = note.userInfo?[AVAudioSession.resumptionContextKey] as? AVAudioSession.ResumptionContext else { return }
                self?.finishAudioInterruption(allowed: context.recommendation == .shouldResume)
            })
            return
        }
        #endif
        notifications.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in self?.interrupted(note) })
    }
    private func bindRemoteCommands() {
        guard remoteTargets.isEmpty else { return }
        if #unavailable(iOS 16.0) { UIApplication.shared.beginReceivingRemoteControlEvents() }
        let center = systemMedia.commands
        func bind(_ command: MPRemoteCommand, _ work: @escaping () -> Void) {
            command.isEnabled = true
            remoteTargets.append((command, command.addTarget { _ in DispatchQueue.main.async(execute: work); return .success }))
        }
        bind(center.playCommand) { [weak self] in self?.resume() }
        bind(center.pauseCommand) { [weak self] in self?.pause() }
        bind(center.togglePlayPauseCommand) { [weak self] in guard let self = self else { return }; if self.desiredPlaying { self.pause() } else { self.resume() } }
        bind(center.nextTrackCommand) { [weak self] in self?.skipTrackFromSystem(1) }
        bind(center.previousTrackCommand) { [weak self] in self?.skipTrackFromSystem(-1) }
        center.skipForwardCommand.isEnabled = false
        center.skipBackwardCommand.isEnabled = false
        center.changePlaybackPositionCommand.isEnabled = true
        remoteTargets.append((center.changePlaybackPositionCommand, center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            DispatchQueue.main.async { self?.seek(event.positionTime) }; return .success
        }))
        updateRemoteTrackCommands()
    }
    private var canSkipTrackFromSystem: Bool {
        guard let id = state.id else { return false }
        return tracks.count > 1 || (tracks.count == 1 && tracks[0].id != id)
    }
    private func skipTrackFromSystem(_ direction: Int) {
        guard canSkipTrackFromSystem else { return }
        advance(direction, restartCurrent: false)
    }
    private func updateRemoteTrackCommands() {
        let enabled = canSkipTrackFromSystem
        let center = systemMedia.commands
        if center.nextTrackCommand.isEnabled != enabled { center.nextTrackCommand.isEnabled = enabled }
        if center.previousTrackCommand.isEnabled != enabled { center.previousTrackCommand.isEnabled = enabled }
    }
}
@_cdecl("init_plugin_ios_player")
func initPlugin() -> Plugin { PlayerPlugin() }
