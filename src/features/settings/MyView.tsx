import { AccountControl } from '../account/AccountControl'
import { SettingsView } from './SettingsView'
export function MyView() {
  return <section className="my-view"><header><span className="eyebrow">YOUR SPACE</span><h2>我的</h2></header><AccountControl expanded /><SettingsView embedded /></section>
}
