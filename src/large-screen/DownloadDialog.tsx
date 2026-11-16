import { accountKeyAt } from '../services/queryKeys'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, FileAudio, Headphones, LoaderCircle } from 'lucide-react'
import { accountEpoch } from '../services/accountScope'
import { commandErrorMessage, getVideoParts } from '../services/desktopApi'
import { getMediaOptions } from '../services/mediaSources'
import { isAndroid } from '../services/platform'
import { androidDownloadDestination, androidDownloadDestinationKey } from '../services/androidDownloads'
import { AndroidDownloadDestinationField } from '../features/downloads/AndroidDownloadDestination'
import { useDownloadRequest, type DownloadOptions } from '../features/downloads/downloadRequest'
import { batchDownloadChoices, downloadOptionsStorageKey, rememberedDownloadOptions } from '../features/downloads/downloadOptions'
import { startDownloadBatch, useDownloadBatch } from '../features/downloads/downloadBatch'
import { LargeDialog } from './LargeDialog'
import { Failure } from './Library'

export function LargeDownloadDialogHost() {
  const request = useDownloadRequest(s => s.request)
  return request ? <LargeDownloadDialog key={`${accountEpoch()}:${request.tracks.map(t => t.id).join(',')}`} request={request}/> : null
}
function LargeDownloadDialog({ request }: { request: NonNullable<ReturnType<typeof useDownloadRequest.getState>['request']> }) {
  const client = useQueryClient(), epoch = accountEpoch(), busy = useDownloadBatch(s => s.busy)
  const [options, setOptions] = useState(rememberedDownloadOptions), [starting, setStarting] = useState(false), [error, setError] = useState('')
  const single = request.tracks.length === 1, track = request.tracks[0]
  const destination = useQuery({ queryKey: androidDownloadDestinationKey, queryFn: () => androidDownloadDestination(), enabled: isAndroid, retry: false })
  const quality = useQuery({ queryKey: accountKeyAt(epoch, 'download-options', track.id), queryFn: async () => {
    const cid = track.source.cid > 0 ? track.source.cid : (await getVideoParts(track.source.bvid)).parts[0]?.cid
    if (!cid) throw Error('暂无可下载的音频')
    return getMediaOptions(track.source.bvid, cid)
  }, enabled: single, retry: false, staleTime: 60000 })
  const choices = single ? quality.data?.audio || [] : batchDownloadChoices
  const missing = options.audioId !== 0 && !choices.some(c => c.id === options.audioId)
  const lossless = !single || !!choices.some(c => c.id === 30251)
  const close = () => { if (!starting) useDownloadRequest.setState({ request: null }) }
  const submit = async () => {
    setStarting(true); setError('')
    try {
      if (await startDownloadBatch(request.tracks, client, { ...options, directory: request.directory, skipExisting: true })) {
        if (epoch !== accountEpoch()) return
        localStorage.setItem(downloadOptionsStorageKey, JSON.stringify(options)); useDownloadRequest.setState({ request: null })
      }
    } catch (cause) { setError(commandErrorMessage(cause)) } finally { setStarting(false) }
  }
  return <LargeDialog title="下载歌曲" className="large-download-dialog" onClose={close}>
    <p className="large-download-title">{single ? track.displayTitle || track.title : `已选 ${request.tracks.length} 首歌曲`}</p>
    <section><h3><Headphones/>下载音质</h3><div className="large-options" role="group" aria-label="下载音质">{[{ id: 0, label: '自动 · 最高 AAC' }, ...choices].map(choice => <button key={choice.id} disabled={starting || busy} aria-pressed={options.audioId === choice.id} onClick={() => setOptions(value => ({ ...value, audioId: choice.id, exportFormat: choice.id !== 30251 && value.exportFormat === 'flac' ? 'auto' : value.exportFormat }))}>{choice.label}</button>)}</div></section>
    <section><h3><FileAudio/>保存格式</h3><div className="large-options" role="group" aria-label="保存格式">{([{ id: 'auto', label: '智能格式' }, { id: 'flac', label: 'FLAC 无损' }, { id: 'original', label: '原始封装' }] as const).map(format => <button key={format.id} disabled={starting || busy || format.id === 'flac' && !lossless} aria-pressed={options.exportFormat === format.id} onClick={() => setOptions(value => ({ ...value, exportFormat: format.id as DownloadOptions['exportFormat'], audioId: format.id === 'flac' ? 30251 : value.audioId }))}>{format.label}</button>)}</div></section>
    {isAndroid && <AndroidDownloadDestinationField disabled={starting || busy}/>}
    {single && quality.isPending && <p role="status" className="large-muted">正在读取可用音质…</p>}
    <Failure error={quality.error || destination.error} retry={() => { if (single) void quality.refetch(); if (isAndroid) void destination.refetch() }}/>
    {missing && !quality.isPending && <p className="large-error">当前音源没有上次选择的音质，请重新选择。</p>}
    {error && <p role="alert" className="large-error">{error}</p>}
    <footer className="large-options"><button disabled={starting} onClick={close}>取消</button><button className="large-primary" disabled={starting || busy || missing || isAndroid && !destination.data?.available || single && (quality.isPending || quality.isError)} onClick={() => void submit()}>{starting ? <LoaderCircle className="spin"/> : <Download/>}开始下载</button></footer>
  </LargeDialog>
}
