import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { Monitor, Smartphone, RefreshCw, LoaderCircle } from 'lucide-react'
import { commandErrorMessage } from '../../services/desktopApi'

type Device = { id: string; name: string; platform: string; current: boolean; retired: boolean; lastActivity?: number; status: 'ready' | 'waiting' | 'retired' | 'dormant' | 'unknown' | 'empty' }
const labels = { ready: '已连接', waiting: '使用旧版同步', retired: '已停用', dormant: '7 天无同步活动', unknown: '活动时间待确认', empty: '暂无同步数据' }
const platforms: Record<string, string> = { macos: 'Mac', windows: 'Windows', android: 'Android', ios: 'iPhone / iPad', ohos: '鸿蒙', linux: 'Linux' }

export function SyncDevices() {
  const client = useQueryClient()
  const [open, setOpen] = useState(false), [pending, setPending] = useState(''), [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  const query = useQuery({ queryKey: ['sync-devices'], queryFn: () => invoke<Device[]>('sync_devices', { refresh: true }), enabled: open, retry: false, staleTime: 60_000 })
  const retire = async (device: Device) => {
    setPending(device.id); setMessage(''); setFailed(false)
    try {
      await invoke('sync_retire_device', { deviceId: device.id })
      client.setQueryData<Device[]>(['sync-devices'], previous => previous?.map(row => row.id === device.id ? { ...row, retired: true, status: 'retired' } : row))
      await query.refetch()
      setMessage('设备已停用，已同步的数据会保留。')
    } catch (error) { setFailed(true); setMessage(commandErrorMessage(error)) }
    finally { setPending('') }
  }
  return <details className="sync-device-section" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>同步设备</summary>
    <div className="sync-device-heading"><p>连续 7 天无同步活动会标记为休眠。停用设备不会删除已同步资料。</p><button type="button" aria-label="刷新同步设备" disabled={query.isFetching || !!pending} onClick={() => void query.refetch()}>{query.isFetching ? <LoaderCircle className="spin" /> : <RefreshCw />}</button></div>
    {query.isPending && <p role="status">正在读取设备…</p>}
    {!!query.data?.length && <ul className="sync-device-list">{query.data.map(device => {
      const mobile = ['ios', 'android', 'ohos'].includes(device.platform)
      const name = platforms[device.platform] || (device.platform === 'unknown' ? `旧设备 ${device.id.slice(-4)}` : device.name)
      return <li key={device.id}>
        <span className="sync-device-icon" aria-hidden="true">{mobile ? <Smartphone /> : <Monitor />}</span>
        <div className="sync-device-copy"><strong>{name}{device.current && <span className="sync-device-current">本机</span>}</strong><small>{device.current && !device.retired ? '已连接' : labels[device.status]}</small></div>
        {!device.current && !device.retired && <button type="button" className="sync-device-retire" disabled={!!pending} aria-label={`停用${name}`} onClick={() => void retire(device)}>{pending === device.id ? <LoaderCircle className="spin" /> : '停用该设备'}</button>}
      </li>
    })}</ul>}
    {query.data?.length === 0 && <p>暂未发现其他同步设备。</p>}
    {(message || query.error) && <p className={(message ? failed : !!query.error) ? 'sync-message' : 'sync-device-note'} role="status">{message || commandErrorMessage(query.error)}</p>}
  </details>
}
