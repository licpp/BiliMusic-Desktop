import { useState } from 'react'
import { AudioLines } from 'lucide-react'
import { useLoudnessSettings, setLoudnessPreference } from '../../services/loudness'
import { applyLoudnessSetting } from '../player/playerStore'
import { commandErrorMessage } from '../../services/userErrors'

export function LoudnessSettings() {
  const enabled = useLoudnessSettings(state => state.enabled)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return <section className="settings-card loudness-setting"><div className="settings-icon"><AudioLines/></div><div><strong id="loudness-label">响度均衡</strong><small>减少不同视频之间的音量差异</small>{error && <small role="alert">{error}</small>}</div>
    <button className="auto-resume-switch" type="button" role="switch" aria-labelledby="loudness-label" aria-checked={enabled} disabled={busy} onClick={async () => {
      setBusy(true); setError('')
      try { setLoudnessPreference(!enabled); await applyLoudnessSetting() }
      catch (cause) { setError(commandErrorMessage(cause)) }
      finally { setBusy(false) }
    }}><span aria-hidden="true"/></button>
  </section>
}
