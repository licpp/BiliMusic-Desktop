import AVFoundation
import MediaPlayer

final class SystemMediaSession {
    let commands: MPRemoteCommandCenter
    let info: MPNowPlayingInfoCenter
    private let session: AnyObject?

    init(players: [AVPlayer]) {
        if #available(iOS 16.0, *) {
            let session = MPNowPlayingSession(players: players)
            session.automaticallyPublishesNowPlayingInfo = false
            self.session = session
            commands = session.remoteCommandCenter
            info = session.nowPlayingInfoCenter
        } else {
            session = nil
            commands = .shared()
            info = .default()
        }
    }

    func activateIfEligible() {
        if #available(iOS 16.0, *), let session = session as? MPNowPlayingSession,
           !session.isActive, session.canBecomeActive {
            session.becomeActiveIfPossible(completion: nil)
        }
    }
}
