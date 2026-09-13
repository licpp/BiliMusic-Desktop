import type { Track } from '../../domain/track'

export const demoTracks: Track[] = [
  { id: 'demo-1', source: { provider: 'bilibili', bvid: 'BV-DEMO-1', cid: 1, page: 1 }, title: '暮色来信', artist: '林川', album: '潮汐手记', durationSeconds: 252, liked: false },
  { id: 'demo-2', source: { provider: 'bilibili', bvid: 'BV-DEMO-2', cid: 2, page: 1 }, title: '城市的回声', artist: '鹿川', album: '在路上', durationSeconds: 225, liked: true },
  { id: 'demo-3', source: { provider: 'bilibili', bvid: 'BV-DEMO-3', cid: 3, page: 1 }, title: '晚风信号', artist: '夏野', album: '下一个清晨', durationSeconds: 268, liked: false },
  { id: 'demo-4', source: { provider: 'bilibili', bvid: 'BV-DEMO-4', cid: 4, page: 1 }, title: '银河便利店', artist: '温柔扫描', album: '城市漂流', durationSeconds: 197, liked: false },
  { id: 'demo-5', source: { provider: 'bilibili', bvid: 'BV-DEMO-5', cid: 5, page: 1 }, title: '某个午后', artist: '陈知尔', album: '日常诗集', durationSeconds: 243, liked: false },
]
