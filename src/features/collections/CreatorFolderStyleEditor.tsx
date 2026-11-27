import { useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { accountEpoch } from '../../services/accountScope'
import { FolderPattern, FolderStyleTile, folderColors, folderPatterns, saveCreatorFolderStyle, useCreatorFolderStyle } from './CreatorFolderArtwork'

export const creatorFolderStyleTitle = '修改文件夹图标'

export function CreatorFolderStyleEditor({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const current = useCreatorFolderStyle(id), epoch = useRef(accountEpoch()).current
  const [color, setColor] = useState(current.color)
  const [pattern, setPattern] = useState(current.pattern)
  const [error, setError] = useState(false)
  const save = () => {
    if (epoch !== accountEpoch()) { onClose(); return }
    try { saveCreatorFolderStyle(id, { color, pattern }) } catch { setError(true); return }
    onClose()
  }

  return <div className="creator-folder-style-editor">
    <div className="creator-folder-style-preview"><FolderStyleTile color={color} pattern={pattern}/><strong>{name}</strong></div>
    <div className="creator-folder-style-field" role="group" aria-label="颜色">
      <span aria-hidden="true">颜色</span>
      <div className="creator-folder-style-options colors">
        {folderColors.map((label, index) => <button type="button" key={label} data-folder-color={index} aria-label={label} title={label} aria-pressed={color === index} onClick={() => setColor(index)}>
          {color === index && <Check size={18} aria-hidden="true"/>}
        </button>)}
      </div>
    </div>
    <div className="creator-folder-style-field" role="group" aria-label="图案">
      <span aria-hidden="true">图案</span>
      <div className="creator-folder-style-options patterns">
        {folderPatterns.map(({ label }, index) => <button type="button" key={label} aria-label={label} title={label} aria-pressed={pattern === index} onClick={() => setPattern(index)}><FolderPattern index={index}/></button>)}
      </div>
    </div>
    {error && <p role="alert" className="inline-error">无法保存图标，请重试</p>}
    <footer><button type="button" className="collection-flat-button" onClick={onClose}>取消</button>
      <button type="button" className="collection-primary" onClick={save}>保存图标</button></footer>
  </div>
}
