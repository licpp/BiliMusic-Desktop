import { SettingsDisclosure } from './SettingsDisclosure'
import { History, Play } from 'lucide-react'
import { useState, type CSSProperties } from 'react'
import { launchPlaybackPreference, usePlayerStore } from '../player/playerStore'
import { RESUME_SLIDER_MAX, resumeSliderValue, resumeThresholdAt, resumeThresholdLabel } from '../player/resumePolicy'

export function ResumeSettings() {
  const threshold = usePlayerStore(state => state.resumeThresholdSeconds)
  const setThreshold = usePlayerStore(state => state.setResumeThreshold)
  const value = resumeSliderValue(threshold)
  const [startOnLaunch, setStartOnLaunch] = useState(() => localStorage.getItem(launchPlaybackPreference) === 'true')
  return <><section className="settings-card loudness-setting"><div className="settings-icon"><Play/></div><div><strong id="play-on-launch-label">打开软件自动开始播放</strong><small>继续播放上次的歌曲</small></div>
    <button className="auto-resume-switch" type="button" role="switch" aria-labelledby="play-on-launch-label" aria-checked={startOnLaunch} onClick={() => {
      localStorage.setItem(launchPlaybackPreference, String(!startOnLaunch))
      setStartOnLaunch(!startOnLaunch)
    }}><span aria-hidden="true"/></button>
  </section><SettingsDisclosure icon={<History/>} title="断点续播" description={<span id="auto-resume-description">{threshold === null ? '单个视频每次从头播放' : threshold === 0 ? '所有视频从上次听到的位置继续' : `仅续播时长不少于 ${threshold / 60} 分钟的视频`}</span>}>
    <div className="resume-setting-expanded"><label id="auto-resume-label" htmlFor="auto-resume-threshold">续播阈值</label>
    <output className="resume-setting-value" htmlFor="auto-resume-threshold">{resumeThresholdLabel(threshold)}</output>
    <div className="resume-setting-slider">
      <input id="auto-resume-threshold" type="range" min={0} max={RESUME_SLIDER_MAX} step={1} value={value}
        aria-labelledby="auto-resume-label" aria-describedby="auto-resume-description" aria-valuetext={resumeThresholdLabel(threshold)}
        style={{ '--range-fill': `${value / RESUME_SLIDER_MAX * 100}%` } as CSSProperties}
        onChange={event => setThreshold(resumeThresholdAt(Number(event.target.value)))}/>
      <div className="resume-setting-endpoints" aria-hidden="true"><span>关闭</span><span>全部续播</span></div>
    </div>
    </div>
  </SettingsDisclosure></>
}
