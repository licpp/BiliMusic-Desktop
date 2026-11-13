// Prepare a silent candidate while the active element keeps playing. The
// caller owns the final handoff and rechecks track, pause and seek intent.
export async function prepareAudioSource(url:string,position:()=>number,valid:()=>boolean,rate:number):Promise<HTMLAudioElement>{
 const candidate=new Audio();candidate.preload='auto';candidate.muted=true;candidate.volume=0;candidate.playbackRate=rate
 const wait=(event:string,test:()=>boolean)=>new Promise<void>((resolve,reject)=>{
  const finish=(error?:Error)=>{clearTimeout(timer);clearInterval(check);candidate.removeEventListener(event,ready);candidate.removeEventListener('error',failed);error?reject(error):resolve()}
  const ready=()=>{if(!valid())finish(new Error('音质切换已取消'));else if(test())finish()}
  const failed=()=>finish(new Error('新音源暂时无法播放，已保留原音质'))
  const timer=setTimeout(failed,12000),check=setInterval(()=>{if(!valid())finish(new Error('音质切换已取消'));else if(test())finish()},100)
  candidate.addEventListener(event,ready);candidate.addEventListener('error',failed);ready()
 })
 try{
  candidate.src=url;candidate.load();await wait('loadedmetadata',()=>candidate.readyState>=1)
  candidate.currentTime=Math.max(0,position());await wait('canplay',()=>!candidate.seeking&&candidate.readyState>=3)
  // Align again after buffering; the original clock has kept moving.
  if(Math.abs(candidate.currentTime-position())>.15){candidate.currentTime=Math.max(0,position());await wait('canplay',()=>!candidate.seeking&&candidate.readyState>=3)}
  if(!valid())throw new Error('音质切换已取消')
  return candidate
 }catch(error){candidate.pause();candidate.removeAttribute('src');candidate.load();throw error}
}
