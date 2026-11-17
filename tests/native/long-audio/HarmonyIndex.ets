import { media } from '@kit.MediaKit';
import { http } from '@kit.NetworkKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
interface Plan {url:string;planMs:number}
@Entry @Component struct Index {
 @State status:string='Starting'; private player:media.AVPlayer|null=null;
 aboutToAppear():void {this.run()}
 async run():Promise<void>{
  const began=Date.now();const request=http.createHttp();
  try {
   const response=await request.request('http://127.0.0.1:63168/plan?quality=0&cache=true');
   const plan=JSON.parse(response.result as string) as Plan;
   const player=await media.createAVPlayer();this.player=player;
   player.on('stateChange',async(state:string)=>{
    hilog.info(0xB110,'LongAudioProbe','state=%{public}s ms=%{public}d',state,Date.now()-began);
    if(state==='initialized')await player.prepare();
    if(state==='prepared'){hilog.info(0xB110,'LongAudioProbe','prepared duration=%{public}d ms=%{public}d',player.duration,Date.now()-began);await player.setVolume(0);await player.play()}
   });
   player.on('error',(e:Error)=>{hilog.error(0xB110,'LongAudioProbe','failed=%{public}s',e.message);this.status=e.message});
   player.on('timeUpdate',(ms:number)=>{if(ms>150){hilog.info(0xB110,'LongAudioProbe','advancing position=%{public}d ms=%{public}d',ms,Date.now()-began);player.pause();this.status='Advancing'}});
   player.url=plan.url;
  }catch(e){this.status='Failed';hilog.error(0xB110,'LongAudioProbe','setup failed')}
  finally{request.destroy()}
 }
 build(){Column(){Text(this.status)}}
}