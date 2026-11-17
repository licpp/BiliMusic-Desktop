import UIKit
import WebKit

@main final class WebProbeDelegate: UIResponder, UIApplicationDelegate {
    func application(_ app:UIApplication, configurationForConnecting session:UISceneSession, options:UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config=UISceneConfiguration(name:"WebMedia",sessionRole:session.role)
        config.delegateClass=WebProbe.self
        return config
    }
}
final class WebProbe: UIResponder, UIWindowSceneDelegate, WKScriptMessageHandler {
    var window:UIWindow?
    var web:WKWebView!
    var samples:[[String:Any]]=[]
    func scene(_ scene:UIScene,willConnectTo session:UISceneSession,options:UIScene.ConnectionOptions) {
        guard let scene=scene as? UIWindowScene else{return}
        let args=ProcessInfo.processInfo.arguments
        let config=WKWebViewConfiguration()
        config.allowsInlineMediaPlayback=true
        config.mediaTypesRequiringUserActionForPlayback=[]
        config.userContentController.add(self,name:"probe")
        web=WKWebView(frame:.zero,configuration:config)
        let root=UIViewController();root.view=web
        window=UIWindow(windowScene:scene);window?.rootViewController=root;window?.makeKeyAndVisible()
        let base=args[1],query=args.count>2 ? args[2] : "video=true",seek=args.count>3 ? Double(args[3]) ?? 0 : 0
        web.loadHTMLString(mediaProbeHTML(base:base,query:query,seek:seek),baseURL:URL(string:base))
    }
    func userContentController(_ userContentController:WKUserContentController,didReceive message:WKScriptMessage) {
        guard let text=message.body as? String,let data=text.data(using:.utf8),let value=try? JSONSerialization.jsonObject(with:data) as? [String:Any] else{return}
        samples.append(value)
        let url=FileManager.default.urls(for:.documentDirectory,in:.userDomainMask)[0].appendingPathComponent("result.json")
        try? JSONSerialization.data(withJSONObject:samples,options:[.prettyPrinted,.sortedKeys]).write(to:url)
        NSLog("WEB_MEDIA_PROBE %@",text)
    }
}
