import { detectedDownloadFamily, downloadFamily, downloadVariant, groupDownloads, largeScreenBitness, preferredDownloadFamily } from './download-options.js?v=0.4.2-car-debian';
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
let selectDownloadFamily;
const element = (tag, text, className) => {
  const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node;
};
async function copyText(text, button, copiedLabel = '已复制 ✓') {
  const original = button.dataset.originalLabel || button.textContent;
  button.dataset.originalLabel = original;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = copiedLabel;
    button.classList.add('copied');
    clearTimeout(button._copyTimer);
    button._copyTimer = setTimeout(() => {
      button.textContent = original;
      button.classList.remove('copied');
    }, 1800);
  } catch {
    button.textContent = '请长按复制';
    setTimeout(() => { button.textContent = original; }, 1800);
  }
}
function platformIcon(platform) {
  const icon = element('div', null, 'download-icon');
  icon.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.6','stroke-linecap':'round','stroke-linejoin':'round'})) svg.setAttribute(key,value);
  const paths = {
    mac: 'M4 3h16a1 1 0 0 1 1 1v12H3V4a1 1 0 0 1 1-1ZM8 21h8M12 16v5',
    windows: 'M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z',
    android: 'M6 9a6 6 0 0 1 12 0ZM8 3 6 1M16 3l2-2M6 12h12v7H6ZM8 19v3M16 19v3M3 12v6M21 12v6',
    'android-large': 'M3 4h18v13H3ZM8 21h8M12 17v4M16 8l4 3-4 3Z',
    ios: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM10 5h4M11 19h2',
    ohos: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM9 9h6M9 13h6M11 19h2',
    linux: 'M8 17V9a4 4 0 0 1 8 0v8M8 11l-3 7 4 3 3-2 3 2 4-3-3-7M10 9h.01M14 9h.01M10 12l2 1 2-1',
  };
  const path = document.createElementNS(svg.namespaceURI,'path'); path.setAttribute('d', paths[platform] || paths.ios); svg.append(path); icon.append(svg);
  return icon;
}
function renderDownloadStats(stats) {
  latestDownloadStats = stats;
  const target = $('#download-stats');
  const format = value => new Intl.NumberFormat('zh-CN').format(value);
  for (const count of document.querySelectorAll('[data-download-count]')) {
    const downloads = (stats.platforms[count.dataset.downloadCount] || 0) + (stats.platforms[count.dataset.downloadCountAlias] || 0);
    count.textContent = `累计下载 ${format(downloads)} 次`;
  }
  const lead = element('span');
  lead.append('累计下载 ', element('strong', format(stats.total)), ' 次');
  target.replaceChildren(element('span', null, 'status-dot'), lead);
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
function renderDownloadPanel(group, item, panel) {
  panel.replaceChildren();
  panel.setAttribute('aria-labelledby', `download-tab-${group.id}`);
  const article = element('article', null, 'download-card');
  const header = element('header', null, 'download-card-header');
  const badge = group.id === 'ios' ? '自签版' : group.id === 'ohos' ? '测试版 · 未签名' : group.id === 'linux' ? '测试版' : item.id === 'android-large-armv7' ? '兼容测试版' : '';
  header.append(element('p', item.requirements, 'download-requirements'));
  if (badge) header.append(element('span', badge, 'download-badge'));
  article.append(header);
  const variants = element('div', null, 'download-variants');
  if (group.items.length > 2) variants.classList.add('download-variants-many');
  if (group.id === 'android') variants.classList.add('download-variants-android');
  variants.setAttribute('role', 'group'); variants.setAttribute('aria-label', `${group.name} 安装包`);
  for (const variant of group.items) {
    const button = element('button', downloadVariant(variant), 'download-variant'); button.type = 'button';
    if (group.id === 'android' && variant.id.startsWith('android-large')) {
      button.replaceChildren(element('span', '车机 / TV'), element('span', largeScreenBitness(variant), 'download-variant-arch'));
      button.setAttribute('aria-label', downloadVariant(variant));
    }
    button.setAttribute('aria-pressed', String(variant.id === item.id));
    button.addEventListener('click', () => {
      renderDownloadPanel(group, variant, panel);
      panel.querySelector(`.download-variant[data-variant="${CSS.escape(variant.id)}"]`)?.focus({ preventScroll: true });
    });
    button.dataset.variant = variant.id; variants.append(button);
  }
  article.append(variants);
  if (item.status !== 'available') article.append(element('p', '即将推出', 'coming-soon'));
  else {
    const body = element('div', null, 'download-body');
    if (item.note) body.append(element('p', item.note, 'download-package-note'));
    const version = element('div', null, 'download-build');
    const count = element('span', '累计下载 —', 'platform-download-count'); count.dataset.downloadCount = item.id;
    if (item.id === 'android-large' && item.architecture === 'ARM64 / ARMv7') count.dataset.downloadCountAlias = 'android-large-armv7';
    version.append(element('strong', `v${item.version || releaseManifest.version}`), element('span', `${(item.size / 1048576).toFixed(1)} MB`), count);
    body.append(version); article.append(body);
    const channels = element('div', null, 'channel-buttons');
    for (const channel of item.channels) {
      const button = element('button', channel.name + (channel.recommended ? ' · 国内推荐' : ''), 'button' + (channel.recommended ? ' recommended' : ''));
      button.type = 'button'; button.dataset.platform = item.id; button.dataset.source = channel.id;
      button.setAttribute('aria-label', `${item.name} ${downloadVariant(item)} ${channel.name} 下载${channel.recommended ? '（国内推荐）' : ''}`);
      button.disabled = !channel.url; if (!channel.url) button.textContent = `${channel.name} · 准备中`;
      channels.append(button);
    }
    article.append(channels);
    const utilities = element('div', null, 'download-utilities');
    const checksum = element('details', null, 'checksum');
    const checksumBox = element('div', null, 'checksum-box');
    const copyBtn = element('button', '复制 SHA-256', 'copy-checksum-btn');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', () => copyText(item.sha256, copyBtn));
    checksumBox.append(element('code', item.sha256), copyBtn);
    checksum.append(element('summary', 'SHA-256 校验值'), checksumBox);
    utilities.append(checksum);
    if (group.id === 'ios' || group.id === 'ohos') {
      const guide = element('a', group.id === 'ios' ? '自签安装说明 ↗' : '签名与安装说明 ↗', 'download-guide'); guide.href = group.id === 'ios' ? '/ios.html' : '/harmony.html'; utilities.append(guide);
    }
    article.append(utilities);
  }
  panel.append(article);
  if (latestDownloadStats) renderDownloadStats(latestDownloadStats);
}
async function loadDownloads() {
  const target = $('#download-platforms');
  try {
    const response = await fetch('/api/v1/releases', { signal:AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('发布信息加载失败');
    releaseManifest = await response.json(); target.replaceChildren();
    $('#release-notes').href = releaseManifest.releaseNotes;
    const versionPill = $('#hero-version');
    if (versionPill && releaseManifest.version) {
      versionPill.textContent = `v${releaseManifest.version} 现已发布`;
      versionPill.hidden = false;
    }
    renderReleaseHistory(releaseManifest);
    $('#feedback-form [name="version"]').placeholder = `例如 ${releaseManifest.version}`;
    const groups = groupDownloads(releaseManifest.platforms);
    const detected = detectedDownloadFamily(navigator.userAgent, navigator.maxTouchPoints);
    const recommended = groups.find(group => group.id === detected && group.items.some(item => item.status === 'available'));
    const pickerHeading = element('div', null, 'download-picker-heading');
    pickerHeading.append(element('strong', '选择设备平台'));
    if (recommended) pickerHeading.append(element('span', `已自动匹配本机：${recommended.name}`, 'download-device-hint'));
    const tabs = element('div', null, 'download-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '下载平台');
    const panel = element('div', null, 'download-panel'); panel.id = 'download-platform-panel'; panel.setAttribute('role', 'tabpanel');
    function select(group, focus = false) {
      for (const tab of tabs.children) { const active = tab.dataset.family === group.id; tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; }
      const tab = [...tabs.children].find(tab => tab.dataset.family === group.id);
      if (focus) tab.focus({ preventScroll: true });
      renderDownloadPanel(group, group.items.find(item => item.status === 'available') || group.items[0], panel);
    }
    selectDownloadFamily = familyId => {
      const match = groups.find(g => g.id === familyId);
      if (match) select(match);
    };
    for (const group of groups) {
      const tab = element('button', null, 'download-tab'); tab.type = 'button'; tab.id = `download-tab-${group.id}`; tab.dataset.family = group.id;
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', panel.id);
      const label = element('span', group.name, 'download-tab-name');
      if (group === recommended) label.append(element('small', '本机', 'download-recommended-label'));
      else if (group.id === 'linux') label.append(element('small', '测试版'));
      tab.append(platformIcon(group.id), label);
      tab.addEventListener('click', () => select(group));
      tab.addEventListener('keydown', event => {
        const index = groups.indexOf(group), next = event.key === 'ArrowRight' ? (index + 1) % groups.length : event.key === 'ArrowLeft' ? (index + groups.length - 1) % groups.length : event.key === 'Home' ? 0 : event.key === 'End' ? groups.length - 1 : -1;
        if (next >= 0) { event.preventDefault(); select(groups[next], true); }
      });
      tabs.append(tab);
    }
    target.append(pickerHeading, tabs, panel);
    const initial = preferredDownloadFamily(groups, navigator.userAgent, navigator.maxTouchPoints);
    if (initial) select(initial);
  } catch {
    target.replaceChildren(element('p','下载信息暂时无法加载，请稍后重试。','download-loading'));
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

// Hero platform chips jump smoothly to download section and pick that platform
document.querySelectorAll('[data-jump-platform]').forEach(chip => {
  chip.addEventListener('click', () => {
    selectDownloadFamily?.(chip.dataset.jumpPlatform);
    $('#download')?.scrollIntoView({ behavior: 'smooth' });
  });
});

// Auto-preselect detected platform in feedback form
(() => {
  const detected = detectedDownloadFamily(navigator.userAgent, navigator.maxTouchPoints);
  const map = { mac: 'macOS', windows: 'Windows', linux: 'Linux', android: 'Android', ios: 'iOS', ohos: 'HarmonyOS' };
  const selectEl = $('#feedback-form [name="platform"]');
  if (selectEl && detected && map[detected]) selectEl.value = map[detected];
})();

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
  const family = platform && downloadFamily(platform.item);
  const installation = family === 'mac' ? 'macOS 安装包尚未经过 Apple 公证。' : family === 'ios' ? 'IPA 需自行签名安装。' : family === 'ohos' ? '未签名 HAP 测试包，需自行签名安装。' : family === 'linux' ? 'Linux 测试版，尚未完成完整设备验收。' : family === 'android' ? 'APK 使用固定签名。' : 'Windows 安装包尚未取得发布者签名。';
  $('#download-availability').textContent = platform ? `${platform.item.name} · ${platform.item.architecture} · 下载源：${platform.channel.name}。${installation}` : '';
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
$('#policy-dialog').addEventListener('click', event => { if (event.target === event.currentTarget) event.currentTarget.close(); });
$('#download-accepted').addEventListener('change', event => { $('#confirm-download').disabled = !event.target.checked || $('#confirm-download').dataset.loaded !== 'true'; });
$('#confirm-download').addEventListener('click', async () => {
  if (!platform || !$('#download-accepted').checked) return;
  const selection=platform, button=$('#confirm-download'); button.disabled=true; button.textContent='正在准备下载…';
  try {
    const response=await fetch('/api/v1/download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({platform:selection.item.id,source:selection.channel.id,consent:true,policyVersion:downloadPolicyVersion}),signal:AbortSignal.timeout(15000)});
    const result=await response.json(); if (!response.ok) throw new Error(result.message || '下载暂时不可用，请稍后重试。');
    if (result.downloadStats) renderDownloadStats(result.downloadStats);
    if (platform !== selection || !$('#policy-dialog').open) return;
    $('#download-availability').textContent=`正在下载 ${result.file}。若未开始下载，可重试或选择另一个下载源。`;
    window.location.assign(result.url);
  } catch (error) { if (platform===selection) $('#download-availability').textContent=error.message || '网络请求失败，请稍后重试。'; }
  finally { if (platform===selection) { button.textContent='重新下载'; button.disabled=!$('#download-accepted').checked; } }
});

// QQ QR modal & one-click copy group number
const qrDialog = $('#qr-dialog');
const openQr = () => qrDialog?.showModal();
$('#open-qq-qr')?.addEventListener('click', openQr);
$('#open-qq-qr-text')?.addEventListener('click', openQr);
$('#close-qr-dialog')?.addEventListener('click', () => qrDialog?.close());
qrDialog?.addEventListener('click', event => { if (event.target === qrDialog) qrDialog.close(); });
$('#copy-qq-btn')?.addEventListener('click', event => copyText(event.currentTarget.dataset.qq, event.currentTarget));
$('#copy-qq-modal-btn')?.addEventListener('click', event => copyText(event.currentTarget.dataset.qq, event.currentTarget, '群号已复制 ✓'));

// Hero living vinyl play animation
$('#hero-play').addEventListener('click', event => {
  const active = $('.floating-player').classList.toggle('playing');
  $('.hero-art').classList.toggle('playing', active);
  event.currentTarget.textContent = active ? 'Ⅱ' : '▶';
  event.currentTarget.setAttribute('aria-label', active ? '暂停播放界面动画示意' : '播放界面动画示意，不播放音频');
});

// Interactive mockup track switching & heart toggle
const mockTracks = [...document.querySelectorAll('[data-mock-track]')];
mockTracks.forEach((row, index) => {
  row.addEventListener('click', () => {
    mockTracks.forEach((other, i) => {
      const isCurrent = other === row;
      other.classList.toggle('active', isCurrent);
      const badge = other.querySelector('.track-idx');
      if (badge) badge.textContent = isCurrent ? '♫' : `0${i + 1}`;
    });
    const titleEl = $('#mock-dock-title'), artistEl = $('#mock-dock-artist'), durEl = $('#mock-dock-duration');
    if (titleEl) titleEl.textContent = row.dataset.title || '';
    if (artistEl) artistEl.textContent = row.dataset.artist || '';
    if (durEl) durEl.textContent = row.dataset.duration || '';
  });
});
$('#mock-dock-heart')?.addEventListener('click', event => {
  const pressed = event.currentTarget.getAttribute('aria-pressed') === 'true';
  event.currentTarget.setAttribute('aria-pressed', String(!pressed));
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

const feedbackImages = [];
const feedbackImageInput = $('#feedback-images');
const feedbackImageList = $('#feedback-image-list');
const feedbackImageStatus = $('#feedback-image-status');
const addFeedbackImages = $('#add-feedback-images');
const feedbackImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const feedbackImageExtensions = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const feedbackImageLimit = 3;
const feedbackImageSizeLimit = 2 * 1024 * 1024;

function renderFeedbackImages() {
  feedbackImageList.replaceChildren();
  feedbackImageList.hidden = feedbackImages.length === 0;
  for (const [index, entry] of feedbackImages.entries()) {
    const thumbnail = element('li', null, 'feedback-image-preview');
    const image = element('img');
    image.src = entry.url;
    image.alt = `截图 ${index + 1}`;
    const remove = element('button', '×', 'feedback-image-remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', `移除截图 ${index + 1}`);
    remove.addEventListener('click', () => {
      URL.revokeObjectURL(entry.url);
      feedbackImages.splice(index, 1);
      feedbackImageStatus.textContent = '';
      renderFeedbackImages();
      addFeedbackImages.focus();
    });
    thumbnail.append(image, remove);
    feedbackImageList.append(thumbnail);
  }
}

addFeedbackImages.addEventListener('click', () => feedbackImageInput.click());
feedbackImageInput.addEventListener('change', () => {
  const messages = new Set();
  for (const file of feedbackImageInput.files) {
    const type = file.type || feedbackImageExtensions[file.name.split('.').pop().toLowerCase()];
    if (!feedbackImageTypes.has(type) || file.size === 0) {
      messages.add('请选择有效的 JPG、PNG 或 WebP 图片。');
      continue;
    }
    if (file.size > feedbackImageSizeLimit) {
      messages.add('每张图片最多 2 MB。');
      continue;
    }
    const sameImage = feedbackImages.some(({ file: selected }) => selected.name === file.name && selected.size === file.size && selected.lastModified === file.lastModified);
    if (sameImage) continue;
    if (feedbackImages.length >= feedbackImageLimit) {
      messages.add('最多可添加 3 张图片。');
      break;
    }
    const image = file.type ? file : new File([file], file.name, { type, lastModified: file.lastModified });
    feedbackImages.push({ file: image, url: URL.createObjectURL(image) });
  }
  feedbackImageInput.value = '';
  feedbackImageStatus.textContent = [...messages].join(' ');
  renderFeedbackImages();
});

$('#feedback-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget, button = $('#submit-feedback'), status = $('#feedback-status');
  const attachments = $('#feedback-attachments');
  button.disabled = true; button.textContent='正在提交…'; status.textContent=''; status.className='';
  attachments.disabled = true;
  try {
    const policy = await getPolicy(), data = Object.fromEntries(new FormData(form));
    data.consent = form.elements.consent.checked; data.policyVersion = policy.version;
    const request = { method:'POST', signal:AbortSignal.timeout(feedbackImages.length ? 60000 : 15000) };
    if (feedbackImages.length) {
      const upload = new FormData();
      upload.append('feedback', JSON.stringify(data));
      for (const { file } of feedbackImages) upload.append('images', file);
      request.body = upload;
    } else {
      request.headers = { 'Content-Type':'application/json' };
      request.body = JSON.stringify(data);
    }
    const response = await fetch('/api/v1/feedback', request);
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '提交失败，请稍后重试。');
    status.textContent = `${result.message} 反馈编号：${result.id}。请保留编号，便于后续联系。`;
    for (const { url } of feedbackImages) URL.revokeObjectURL(url);
    feedbackImages.length = 0;
    feedbackImageStatus.textContent = '';
    renderFeedbackImages();
    form.reset(); updateCategory();
  } catch (error) {
    status.className='error'; status.textContent = error.name === 'TimeoutError' ? '请求超时，反馈可能已收到；请稍后确认，避免重复提交。' : error.message || '网络连接失败，请稍后重试。';
  } finally { attachments.disabled=false; button.disabled=false; button.textContent='提交反馈 ↗'; }
});
