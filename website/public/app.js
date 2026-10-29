const $ = selector => document.querySelector(selector);
if (location.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(location.hostname)) {
  const note = document.createElement('p'); note.className='transport-note';
  note.textContent='当前为 HTTP 连接，信息传输未加密。请勿提交敏感资料；联系方式可不填（版权反馈除外）。';
  $('#feedback-form').prepend(note);
}
let policyPromise;
let platform;
let releaseManifest;
let downloadPolicyVersion;
let latestDownloadStats;
const element = (tag, text, className) => {
  const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node;
};
function renderDownloadStats(stats) {
  latestDownloadStats = stats;
  const target = $('#download-stats');
  const format = value => new Intl.NumberFormat('zh-CN').format(value);
  for (const count of document.querySelectorAll('[data-download-count]')) {
    count.textContent = ` · 累计下载 ${format(stats.platforms[count.dataset.downloadCount] || 0)} 次`;
  }
  target.replaceChildren(element('span', `三端累计下载 ${format(stats.total)} 次`));
  const date = new Date(stats.startedAt).toLocaleDateString('zh-CN', { timeZone:'Asia/Shanghai' });
  target.append(element('small',`自 ${date} 起统计官网发起下载次数`));
}
async function loadDownloadStats() {
  try {
    const response = await fetch('/api/v1/download-stats', { signal:AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('unavailable');
    renderDownloadStats(await response.json());
  } catch { $('#download-stats').replaceChildren(element('span','下载统计暂不可用')); }
}
loadDownloadStats();
async function loadDownloads() {
  const target = $('#download-platforms');
  try {
    const response = await fetch('/api/v1/releases', { signal:AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('发布信息加载失败');
    releaseManifest = await response.json(); target.replaceChildren();
    $('#release-notes').href = releaseManifest.releaseNotes;
    $('#feedback-form [name="version"]').placeholder = `例如 ${releaseManifest.version}`;
    for (const item of releaseManifest.platforms) {
      const article = element('article', null, item.id === 'android' ? 'android-card' : '');
      article.append(element('div', item.id === 'mac' ? '⌘' : item.id === 'windows' ? '⊞' : '↗', 'os-symbol'));
      const heading = element('div'); heading.append(element('h3',`BiliMusic for ${item.name}`));
      heading.append(element('p',item.status === 'available' ? item.architecture : '移动端正在规划中，敬请期待。')); article.append(heading);
      if (item.status !== 'available') article.append(element('span','Coming soon','coming-soon'));
      else {
        const version = element('p',`v${releaseManifest.version} · ${(item.size / 1048576).toFixed(1)} MB · ${item.requirements}`,'download-version');
        const count = element('span',' · 累计下载 —','platform-download-count');
        count.dataset.downloadCount = item.id; version.append(count); article.append(version);
        const channels = element('div', null, 'channel-buttons');
        for (const channel of item.channels) {
          const button = element('button',channel.name + (channel.recommended ? ' · 国内推荐' : ''),'button' + (channel.recommended ? ' recommended' : ''));
          button.type='button'; button.dataset.platform=item.id; button.dataset.source=channel.id;
          button.setAttribute('aria-label',`${item.name} ${channel.name} 下载${channel.recommended ? '（国内推荐）' : ''}`);
          button.disabled=!channel.url; if (!channel.url) button.textContent=`${channel.name} · 准备中`;
          channels.append(button);
        }
        article.append(channels);
        const checksum = element('details',null,'checksum'); checksum.append(element('summary','查看 SHA-256 校验值'),element('code',item.sha256)); article.append(checksum);
      }
      target.append(article);
    }
    if (latestDownloadStats) renderDownloadStats(latestDownloadStats);
  } catch {
    target.replaceChildren(element('p','下载信息暂时无法加载，请稍后重试。'));
    const retry=element('button','重新加载','button'); retry.type='button'; retry.dataset.retry='true'; target.append(retry);
  }
}
$('#download-platforms').addEventListener('click',event => {
  const button=event.target.closest('button'); if (!button) return;
  if (button.dataset.retry) return loadDownloads();
  const item=releaseManifest?.platforms.find(item=>item.id===button.dataset.platform);
  const channel=item?.channels.find(channel=>channel.id===button.dataset.source);
  if (item && channel?.url) openPolicy({item,channel});
});
loadDownloads();
function getPolicy() {
  return policyPromise ||= fetch('/api/v1/policy').then(r => { if (!r.ok) throw new Error('无法加载使用说明，请稍后重试。'); return r.json(); }).catch(error => { policyPromise = undefined; throw error; });
}
async function openPolicy(downloadPlatform) {
  platform = downloadPlatform;
  const dialog = $('#policy-dialog');
  $('#download-consent').hidden = !platform;
  $('#policy-close').hidden = Boolean(platform);
  $('#download-accepted').checked = false;
  $('#confirm-download').disabled = true;
  $('#confirm-download').dataset.loaded = 'false';
  $('#confirm-download').textContent = '同意并下载';
  $('#download-availability').textContent = platform ? `${platform.item.name} · ${platform.item.architecture} · 下载源：${platform.channel.name}。${platform.item.id === 'mac' ? 'macOS 使用临时签名，尚未经过 Apple 公证，首次打开可能需在隐私与安全性中单独允许。' : platform.item.id === 'android' ? 'Android 仅支持 ARM64，使用固定签名。' : 'Windows 安装包尚未取得发布者签名。'}下载前请确认来源与校验值。` : '';
  const content = $('#policy-content'); content.replaceChildren();
  const loading = document.createElement('p'); loading.textContent = '正在加载说明…'; content.append(loading);
  dialog.showModal(); dialog.scrollTop = 0; content.scrollTop = 0;
  try {
    const policy = await getPolicy(); content.replaceChildren();
    downloadPolicyVersion=policy.version;
    const date = document.createElement('small'); date.textContent = `说明版本：${policy.version}`; content.append(date);
    for (const [heading, text] of policy.sections) {
      const section = document.createElement('section'), h = document.createElement('h3'), p = document.createElement('p');
      h.textContent = heading; p.textContent = text; section.append(h,p); content.append(section);
    }
    const link = document.createElement('a'); link.href = 'https://www.bilibili.com/blackboard/protocal/licence.html'; link.target='_blank'; link.rel='noopener noreferrer'; link.textContent='查看哔哩哔哩用户使用协议 ↗'; content.append(link);
    $('#confirm-download').dataset.loaded = 'true';
    $('#confirm-download').disabled = !$('#download-accepted').checked;
  } catch (error) { content.textContent = error.message; $('#confirm-download').dataset.loaded='false'; }
}
document.querySelectorAll('[data-policy]').forEach(button => button.addEventListener('click', () => openPolicy()));
$('.close-dialog').addEventListener('click', () => $('#policy-dialog').close());
$('#policy-close').addEventListener('click', () => $('#policy-dialog').close());
$('#download-accepted').addEventListener('change', event => { $('#confirm-download').disabled = !event.target.checked || $('#confirm-download').dataset.loaded !== 'true'; });
$('#confirm-download').addEventListener('click', async () => {
  if (!platform || !$('#download-accepted').checked) return;
  const selection=platform, button=$('#confirm-download'); button.disabled=true; button.textContent='正在准备下载…';
  try {
    const response=await fetch('/api/v1/download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({platform:selection.item.id,source:selection.channel.id,consent:true,policyVersion:downloadPolicyVersion}),signal:AbortSignal.timeout(15000)});
    const result=await response.json(); if (!response.ok) throw new Error(result.message || '下载暂时不可用，请稍后重试。');
    if (result.downloadStats) renderDownloadStats(result.downloadStats);
    if (platform !== selection || !$('#policy-dialog').open) return;
    $('#download-availability').textContent=`正在前往 ${selection.channel.name} 下载 ${result.file}。若未开始下载，可重试或选择另一个下载源。`;
    window.location.assign(result.url);
  } catch (error) { if (platform===selection) $('#download-availability').textContent=error.message || '网络请求失败，请稍后重试。'; }
  finally { if (platform===selection) { button.textContent='重新下载'; button.disabled=!$('#download-accepted').checked; } }
});
$('#hero-play').addEventListener('click', event => {
  const active = $('.floating-player').classList.toggle('playing');
  event.currentTarget.textContent = active ? 'Ⅱ' : '▶';
  event.currentTarget.setAttribute('aria-label', active ? '暂停播放界面动画示意' : '播放界面动画示意，不播放音频');
});
const tabs = [...document.querySelectorAll('[data-preview]')];
function selectTab(tab) {
  for (const item of tabs) {
    const active = item === tab; item.setAttribute('aria-selected',String(active)); item.tabIndex = active ? 0 : -1;
    $(`#panel-${item.dataset.preview}`).hidden = !active;
  }
  const index = tabs.indexOf(tab); $('.art-caption span:last-child').textContent = `0${index + 1} / 03`;
}
for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', event => {
    let index = tabs.indexOf(tab);
    if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') index = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = tabs.length - 1;
    else return;
    event.preventDefault(); selectTab(tabs[index]); tabs[index].focus();
  });
}
$('#rights-feedback').addEventListener('click', () => {
  $('#feedback-form [name=category]').value='copyright'; updateCategory();
  $('#feedback-form [name=title]').focus();
});
function updateCategory() { $('#feedback-form [name=contact]').required = $('#feedback-form [name=category]').value === 'copyright'; }
$('#feedback-form [name=category]').addEventListener('change',updateCategory);
$('#feedback-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget, button = $('#submit-feedback'), status = $('#feedback-status');
  button.disabled = true; button.textContent='正在提交…'; status.textContent=''; status.className='';
  try {
    const policy = await getPolicy(), data = Object.fromEntries(new FormData(form));
    data.consent = form.elements.consent.checked; data.policyVersion = policy.version;
    const response = await fetch('/api/v1/feedback', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data), signal:AbortSignal.timeout(15000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '提交失败，请稍后重试。');
    status.textContent = `${result.message} 反馈编号：${result.id}。请保留编号，便于后续联系。`;
    form.reset(); updateCategory();
  } catch (error) {
    status.className='error'; status.textContent = error.name === 'TimeoutError' ? '请求超时，反馈可能已收到；请稍后确认，避免重复提交。' : error.message || '网络连接失败，请稍后重试。';
  } finally { button.disabled=false; button.textContent='提交反馈 ↗'; }
});
