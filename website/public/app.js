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
function platformIcon(platform) {
  const icon = element('div', null, 'download-icon');
  icon.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.6','stroke-linecap':'round','stroke-linejoin':'round'})) svg.setAttribute(key,value);
  const paths = {
    mac: 'M4 3h16a1 1 0 0 1 1 1v12H3V4a1 1 0 0 1 1-1ZM8 21h8M12 16v5',
    windows: 'M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z',
    android: 'M6 9a6 6 0 0 1 12 0ZM8 3 6 1M16 3l2-2M6 12h12v7H6ZM8 19v3M16 19v3M3 12v6M21 12v6',
    ios: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM10 5h4M11 19h2',
  };
  const path = document.createElementNS(svg.namespaceURI,'path'); path.setAttribute('d', paths[platform] || paths.ios); svg.append(path); icon.append(svg);
  return icon;
}
function renderDownloadStats(stats) {
  latestDownloadStats = stats;
  const target = $('#download-stats');
  const format = value => new Intl.NumberFormat('zh-CN').format(value);
  for (const count of document.querySelectorAll('[data-download-count]')) {
    count.textContent = `累计下载 ${format(stats.platforms[count.dataset.downloadCount] || 0)} 次`;
  }
  target.replaceChildren(element('span', `累计下载 ${format(stats.total)} 次`));
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
function renderReleaseHistory(manifest) {
  const entries = Array.isArray(manifest.history) ? manifest.history : [];
  const currentIndex = entries.findIndex(entry => entry.version === manifest.version);
  const section = $('#changelog');
  if (currentIndex < 0) { section.hidden = true; return; }
  const render = (entry, current = false) => {
    const card = element('article', null, 'release-history-card' + (entry.kind === 'major' ? ' major-release-card' : ''));
    const heading = element('div', null, 'release-history-version');
    heading.append(element('h3', `v${entry.version}`));
    if (current) heading.append(element('span', '当前版本', 'current-release-label'));
    if (entry.kind === 'major') heading.append(element('span', '大版本更新', 'major-release-label'));
    if (entry.publishedAt) {
      const date = new Date(entry.publishedAt).toLocaleDateString('zh-CN', { timeZone:'Asia/Shanghai' });
      heading.append(element('small', date));
    }
    const list = element('ul');
    for (const change of entry.changes) list.append(element('li', change));
    card.append(heading);
    if (entry.summary) card.append(element('p', entry.summary, 'release-history-summary'));
    card.append(list);
    return card;
  };
  const previous = entries.slice(currentIndex + 1);
  $('#current-release-changes').replaceChildren(render(entries[currentIndex], true));
  $('#past-release-changes').replaceChildren(...previous.map(entry => render(entry)));
  $('#past-releases').hidden = previous.length === 0;
  section.hidden = false;
}
async function loadDownloads() {
  const target = $('#download-platforms');
  try {
    const response = await fetch('/api/v1/releases', { signal:AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('发布信息加载失败');
    releaseManifest = await response.json(); target.replaceChildren();
    $('#release-notes').href = releaseManifest.releaseNotes;
    renderReleaseHistory(releaseManifest);
    $('#feedback-form [name="version"]').placeholder = `例如 ${releaseManifest.version}`;
    for (const item of releaseManifest.platforms) {
      const article = element('article', null, 'download-card');
      const header = element('header', null, 'download-card-header');
      const heading = element('div', null, 'download-heading');
      const title = element('div', null, 'download-title'); title.append(element('h3',item.name));
      if (item.id === 'ios') title.append(element('span','自签版','download-badge'));
      heading.append(title,element('p',item.architecture,'download-architecture'));
      header.append(platformIcon(item.id),heading); article.append(header);
      if (item.status !== 'available') article.append(element('span','Coming soon','coming-soon'));
      else {
        const body = element('div',null,'download-body');
        const version = element('div',null,'download-build');
        const count = element('span','累计下载 —','platform-download-count');
        count.dataset.downloadCount = item.id;
        version.append(element('strong',`v${releaseManifest.version}`),element('span',`${(item.size / 1048576).toFixed(1)} MB`),count);
        body.append(version,element('p',item.requirements,'download-requirements')); article.append(body);
        const channels = element('div', null, 'channel-buttons');
        for (const channel of item.channels) {
          const button = element('button',channel.name + (channel.recommended ? ' · 国内推荐' : ''),'button' + (channel.recommended ? ' recommended' : ''));
          button.type='button'; button.dataset.platform=item.id; button.dataset.source=channel.id;
          button.setAttribute('aria-label',`${item.name} ${channel.name} 下载${channel.recommended ? '（国内推荐）' : ''}`);
          button.disabled=!channel.url; if (!channel.url) button.textContent=`${channel.name} · 准备中`;
          channels.append(button);
        }
        article.append(channels);
        const utilities = element('div',null,'download-utilities');
        const checksum = element('details',null,'checksum'); checksum.append(element('summary','查看 SHA-256 校验值'),element('code',item.sha256));
        utilities.append(checksum);
        if (item.id === 'ios') {
          const guide=element('a','自签安装说明 ↗','download-guide'); guide.href='/ios.html'; utilities.append(guide);
        }
        article.append(utilities);
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
  $('#download-availability').textContent = platform ? `${platform.item.name} · ${platform.item.architecture} · 下载源：${platform.channel.name}。${platform.item.id === 'mac' ? 'macOS 使用临时签名，尚未经过 Apple 公证，首次打开可能需在隐私与安全性中单独允许。' : platform.item.id === 'ios' ? 'iOS 下载的是未签名 IPA，必须使用自己的 Apple ID 自行签名后安装，不是 App Store 版本。' : platform.item.id === 'android' ? 'Android 仅支持 ARM64，使用固定签名。' : 'Windows 安装包尚未取得发布者签名。'}下载前请确认来源与校验值。` : '';
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
