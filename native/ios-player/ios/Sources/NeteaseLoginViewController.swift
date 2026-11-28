import UIKit
import WebKit

struct NeteaseLoginCookies: Encodable {
    let musicU: String
    let csrf: String
}

enum NeteaseLoginOutcome {
    case authorized(NeteaseLoginCookies)
    case cancelled
    case unavailable
    case timedOut
}

final class NeteaseLoginViewController: UIViewController, WKNavigationDelegate, WKUIDelegate,
    WKHTTPCookieStoreObserver, UIAdaptivePresentationControllerDelegate {
    private static let loginURL = URL(string: "https://music.163.com/#/login")!
    private let webview: WKWebView
    private var completion: ((NeteaseLoginOutcome) -> Void)?
    private var expiration: DispatchWorkItem?

    init(completion: @escaping (NeteaseLoginOutcome) -> Void) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        webview = WKWebView(frame: .zero, configuration: configuration)
        self.completion = completion
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    override func loadView() {
        let container = UIView()
        container.backgroundColor = .systemBackground
        container.addSubview(webview)
        webview.translatesAutoresizingMaskIntoConstraints = false
        webview.scrollView.contentInsetAdjustmentBehavior = .never
        let safeArea = container.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            webview.topAnchor.constraint(equalTo: safeArea.topAnchor),
            webview.bottomAnchor.constraint(equalTo: safeArea.bottomAnchor),
            webview.leadingAnchor.constraint(equalTo: safeArea.leadingAnchor),
            webview.trailingAnchor.constraint(equalTo: safeArea.trailingAnchor)
        ])
        view = container
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "网易云音乐"
        navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .close, target: self, action: #selector(cancel))
        let loading = UIActivityIndicatorView(style: .medium)
        loading.startAnimating()
        navigationItem.rightBarButtonItem = UIBarButtonItem(customView: loading)
        webview.navigationDelegate = self
        webview.uiDelegate = self
        webview.configuration.websiteDataStore.httpCookieStore.add(self)
        webview.load(URLRequest(url: Self.loginURL))
        // Release the native callback even if the app-side timeout could not dismiss the sheet.
        let expiration = DispatchWorkItem { [weak self] in self?.finish(.timedOut) }
        self.expiration = expiration
        DispatchQueue.main.asyncAfter(deadline: .now() + 305, execute: expiration)
    }

    @objc func cancel() { finish(.cancelled) }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        finish(.cancelled, dismiss: false)
    }

    private func finish(_ outcome: NeteaseLoginOutcome, dismiss: Bool = true) {
        guard let completion else { return }
        self.completion = nil
        expiration?.cancel()
        expiration = nil
        webview.stopLoading()
        webview.navigationDelegate = nil
        webview.uiDelegate = nil
        webview.configuration.websiteDataStore.httpCookieStore.remove(self)
        if dismiss { navigationController?.dismiss(animated: true) }
        completion(outcome)
    }

    private static func allowsNavigation(_ url: URL?) -> Bool {
        guard let url, url.scheme == "https", url.user == nil, url.password == nil,
              url.port == nil || url.port == 443, let host = url.host?.lowercased() else { return false }
        return host == "163.com" || host.hasSuffix(".163.com")
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.targetFrame?.isMainFrame == false {
            // The official page may load its challenge in a third-party frame.
            let url = navigationAction.request.url
            decisionHandler(url?.scheme == "https" || url?.absoluteString == "about:blank" ? .allow : .cancel)
        } else {
            decisionHandler(Self.allowsNavigation(navigationAction.request.url) ? .allow : .cancel)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.isForMainFrame && !Self.allowsNavigation(navigationResponse.response.url) ? .cancel : .allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil, Self.allowsNavigation(navigationAction.request.url) {
            webView.load(navigationAction.request)
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let error = error as NSError
        if webView.url == nil, error.domain == NSURLErrorDomain, error.code != NSURLErrorCancelled {
            finish(.unavailable)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        navigationItem.rightBarButtonItem = nil
        cookiesDidChange(in: webView.configuration.websiteDataStore.httpCookieStore)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        finish(.unavailable)
    }

    func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
        guard completion != nil, Self.allowsNavigation(webview.url) else { return }
        cookieStore.getAllCookies { [weak self] cookies in
            guard let self, self.completion != nil, Self.allowsNavigation(self.webview.url) else { return }
            let officialCookies = cookies.filter { cookie in
                let domain = cookie.domain.lowercased()
                let eligibleDomain = domain == "music.163.com" || domain == ".music.163.com" || domain == ".163.com"
                return eligibleDomain && cookie.path == "/" && (cookie.expiresDate.map { $0 > Date() } ?? true)
            }
            guard let login = officialCookies.first(where: { $0.name == "MUSIC_U" && !$0.value.isEmpty }) else { return }
            let csrf = officialCookies.first(where: { $0.name == "__csrf" })?.value ?? ""
            self.finish(.authorized(.init(musicU: login.value, csrf: csrf)))
        }
    }
}
