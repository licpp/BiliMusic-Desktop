import UIKit
import AVFoundation
@main final class AppDelegate:UIResponder,UIApplicationDelegate {
 func application(_ app:UIApplication,configurationForConnecting session:UISceneSession,options:UIScene.ConnectionOptions)->UISceneConfiguration {let c=UISceneConfiguration(name:"Probe",sessionRole:session.role);c.delegateClass=Probe.self;return c}
}
final class Probe: UIResponder, UIWindowSceneDelegate {
 var endObserver:NSObjectProtocol?;var window:UIWindow?;let player=AVPlayer();var status:NSKeyValueObservation?;var clock:NSKeyValueObservation?;var timer:Timer?;var began=ProcessInfo.processInfo.systemUptime;var launched=ProcessInfo.processInfo.systemUptime;var samples:[[String:Any]]=[];var finished=false;var seekIssued=false;var seekComplete=false;var seekTarget=0.0;var mode="auto";var base="";var plan:[String:Any]=[:];let label=UILabel()
 func scene(_ scene:UIScene,willConnectTo session:UISceneSession,options:UIScene.ConnectionOptions) {
  guard let scene=scene as? UIWindowScene else{return}
  let args=ProcessInfo.processInfo.arguments;base=args[1];mode=args.count>2 ? args[2]:"auto"
  let root=UIViewController();root.view.backgroundColor = .systemBackground;label.frame=CGRect(x:20,y:100,width:350,height:500);label.numberOfLines=0;root.view.addSubview(label)
  window=UIWindow(windowScene:scene);window?.rootViewController=root;window?.makeKeyAndVisible()
  try? AVAudioSession.sharedInstance().setCategory(.playback);try? AVAudioSession.sharedInstance().setActive(true)
  let query=args.count>3 ? args[3]:"quality=0&cache=true";seekTarget=args.count>4 ? (Double(args[4]) ?? 0):0;let url=URL(string:base+"/plan?"+query)!
  URLSession.shared.dataTask(with:url){[weak self] data,_,error in
   DispatchQueue.main.async {guard let self else{return};guard let data,let value=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let raw=value["url"] as? String,let url=validatedLocalMediaURL(raw) else{self.record("plan_failed");self.finish("plan_failed");return}
    self.plan=value.filter{$0.key != "url"};self.begin(url)
   }
  }.resume()
 }
 func record(_ event:String) {
  let item=player.currentItem
  let buffered=item?.loadedTimeRanges.map {let r=$0.timeRangeValue;return [r.start.seconds,r.duration.seconds]} ?? []
  var sample:[String:Any] = ["event":event,"ms":Int((ProcessInfo.processInfo.systemUptime-began)*1000),"position":player.currentTime().seconds.isFinite ? player.currentTime().seconds:0,"control":player.timeControlStatus.rawValue,"reason":player.reasonForWaitingToPlay?.rawValue ?? "","status":item?.status.rawValue ?? -1,"buffer":buffered,"keepUp":item?.isPlaybackLikelyToKeepUp ?? false,"empty":item?.isPlaybackBufferEmpty ?? true]
  if let d=item?.duration.seconds,d.isFinite {sample["duration"]=d}
  if let e=item?.error as? NSError {sample["errorDomain"]=e.domain;sample["errorCode"]=e.code}
  samples.append(sample);if event != "sample" || samples.count%4 == 0 {NSLog("LONG_AUDIO %@",String(data:try! JSONSerialization.data(withJSONObject:sample),encoding:.utf8)!)}
  label.text="BiliMusic AVPlayer probe\n\(mode)\n\(sample)"
 }
 func begin(_ url:URL) {
  began=ProcessInfo.processInfo.systemUptime;player.automaticallyWaitsToMinimizeStalling=true
  let item=AVPlayerItem(url:url);item.preferredForwardBufferDuration=2
  player.replaceCurrentItem(with:item)
  endObserver=NotificationCenter.default.addObserver(forName:.AVPlayerItemDidPlayToEndTime,object:item,queue:.main){[weak self] _ in self?.finish("ended")}
  status=item.observe(\.status,options:[.initial,.new]) {[weak self] item,_ in DispatchQueue.main.async {guard let self else{return};self.record("item_status");if item.status == .readyToPlay {if self.seekTarget>0 && !self.seekIssued {self.seekIssued=true;self.player.pause();self.record("seek_start");self.player.seek(to:CMTime(seconds:self.seekTarget,preferredTimescale:600),toleranceBefore:CMTime(seconds:0.1,preferredTimescale:600),toleranceAfter:CMTime(seconds:0.1,preferredTimescale:600)){ok in DispatchQueue.main.async {self.seekComplete=ok;self.record(ok ? "seek_complete":"seek_failed");self.player.rate=1}};return};if self.mode == "immediate" {self.player.playImmediately(atRate:1)}else{self.player.rate=1}};if item.status == .failed{self.finish("failed")}}}
  clock=player.observe(\.timeControlStatus,options:[.initial,.new]){[weak self] _,_ in DispatchQueue.main.async {self?.record("control_status")}}
  player.rate=1;record("start")
  timer=Timer.scheduledTimer(withTimeInterval:0.25,repeats:true){[weak self] _ in guard let self,!self.finished else{return};self.record("sample");if self.mode != "end" && self.player.currentTime().seconds>0.15 && (self.seekTarget==0 || self.seekComplete && self.player.currentTime().seconds>self.seekTarget+0.15) {self.finish("advancing")}else if ProcessInfo.processInfo.systemUptime-self.began>45 {self.finish("timeout")}}
 }
 func finish(_ result:String) {
  guard !finished else{return};finished=true;timer?.invalidate();if let endObserver {NotificationCenter.default.removeObserver(endObserver)};record(result);player.pause()
  let value:[String:Any] = ["mode":mode,"result":result,"plan":plan,"totalMs":Int((ProcessInfo.processInfo.systemUptime-launched)*1000),"samples":samples]
  let data=try! JSONSerialization.data(withJSONObject:value,options:[.prettyPrinted,.sortedKeys]);let file=FileManager.default.urls(for:.documentDirectory,in:.userDomainMask)[0].appendingPathComponent("result.json");try? data.write(to:file)
  var request=URLRequest(url:URL(string:base+"/result")!);request.httpMethod="POST";request.setValue("application/json",forHTTPHeaderField:"Content-Type");request.httpBody=data
  URLSession.shared.dataTask(with:request){_,_,_ in NSLog("LONG_AUDIO complete %@",result)}.resume()
 }
}
