import Foundation

// Real WebKit media element, shared by the macOS and iOS integration probes.
func mediaProbeHTML(base: String, query: String, seek: Double) -> String {
    let options = String(data: try! JSONSerialization.data(withJSONObject: ["base":base,"query":query,"seek":seek]), encoding:.utf8)!
    return """
    <meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;background:#182229;color:white;margin:16px}video{width:100%;max-height:70vh;background:black}</style>
    <p>BiliMusic WebKit media probe</p><script>
    const options=\(options), post=x=>window.webkit.messageHandlers.probe.postMessage(JSON.stringify(x));
    const params=new URLSearchParams(options.query), video=params.get('video')==='true';
    const began=performance.now(), a=document.createElement(video?'video':'audio');window.audio=a;
    a.preload='auto';a.muted=video;a.playsInline=true;document.body.append(a);
    let last=0,done=false,timer;const seek=options.seek;
    const finish=result=>{if(done)return;done=true;clearTimeout(timer);a.pause();post({done:true,result,ms:Math.round(performance.now()-began)})};
    if(seek>0)a.addEventListener('loadedmetadata',()=>{a.currentTime=seek},{once:true});
    const sample=event=>{if(done)return;post({event,ms:Math.round(performance.now()-began),position:a.currentTime,duration:Number.isFinite(a.duration)?a.duration:null,width:a.videoWidth,height:a.videoHeight,frames:a.webkitDecodedFrameCount,ready:a.readyState,network:a.networkState,error:a.error?.code});if(a.currentTime>seek+.15&&(!video||a.readyState>=2&&a.videoWidth>0))finish('advancing')};
    for(const e of ['loadedmetadata','canplay','playing','waiting','error','durationchange','seeked'])a.addEventListener(e,()=>sample(e));
    a.addEventListener('timeupdate',()=>{if(performance.now()-last>400){last=performance.now();sample('time')}});
    fetch(options.base+'/plan?'+options.query).then(r=>r.json()).then(p=>{post({event:'plan',planMs:p.planMs,codecs:p.codecs,quality:p.quality,bvid:p.bvid});a.src=p.url;a.play().catch(e=>{if(!done)post({event:'play_error',message:e.message})})}).catch(e=>finish(e.message));
    timer=setTimeout(()=>{sample('timeout');finish('timeout')},Number(params.get('probe_timeout'))||45000);
    </script>
    """
}
