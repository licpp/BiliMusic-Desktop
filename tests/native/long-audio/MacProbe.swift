import AppKit
import WebKit
final class Probe:NSObject,WKScriptMessageHandler {
 var web:WKWebView!;var window:NSWindow!;var timeout:Timer?
 func start() {
  let cfg=WKWebViewConfiguration();cfg.mediaTypesRequiringUserActionForPlayback=[];cfg.userContentController.add(self,name:"probe")
  web=WKWebView(frame:NSRect(x:0,y:0,width:400,height:200),configuration:cfg)
  window=NSWindow(contentRect:web.frame,styleMask:[.titled,.closable],backing:.buffered,defer:false);window.title="BiliMusic long audio diagnostic";window.contentView=web
  let base=CommandLine.arguments[1];let query=CommandLine.arguments.count>2 ? CommandLine.arguments[2]:"quality=0&cache=true";let seek=CommandLine.arguments.count>3 ? (Double(CommandLine.arguments[3]) ?? 0):0
  web.loadHTMLString(mediaProbeHTML(base:base,query:query,seek:seek),baseURL:URL(string:base))
  window.orderFrontRegardless()
  timeout=Timer.scheduledTimer(withTimeInterval:50,repeats:false){[weak self] _ in self?.web.evaluateJavaScript("JSON.stringify({result:'timeout',position:window.audio?.currentTime,duration:window.audio?.duration,ready:window.audio?.readyState})"){value,_ in print(value ?? "timeout");fflush(stdout);NSApplication.shared.terminate(nil)}}
 }
 func userContentController(_ userContentController:WKUserContentController,didReceive message:WKScriptMessage){ print(message.body);fflush(stdout);if let text=message.body as? String,text.contains("\"done\":true"){NSApplication.shared.terminate(nil)}}
}
@main struct MacMediaProbe {
 static func main() { let app=NSApplication.shared;app.setActivationPolicy(.accessory);let probe=Probe();probe.start();app.run() }
}
