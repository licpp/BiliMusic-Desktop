const $ = selector => document.querySelector(selector);
if (location.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(location.hostname)) {
  const note = document.createElement('p'); note.className='transport-note';
  note.textContent='当前为 HTTP 连接，信息传输未加密。请勿提交敏感资料；联系方式可不填（版权反馈除外）。';
  $('#feedback-form').prepend(note);
}
let policyPromise;
let platform;
function getPolicy() {
  return policyPromise ||= fetch('/api/policy').then(r => { if (!r.ok) throw new Error('无法加载使用说明，请稍后重试。'); return r.json(); }).catch(error => { policyPromise = undefined; throw error; });
}
async function openPolicy(downloadPlatform) {
  platform = downloadPlatform;
  const dialog = $('#policy-dialog');
  $('#download-consent').hidden = !platform;
  $('#policy-close').hidden = Boolean(platform);
  $('#download-accepted').checked = false;
  $('#confirm-download').disabled = true;
  $('#confirm-download').dataset.loaded = 'false';
  $('#download-availability').textContent = platform ? `${platform} 安装包尚未公开发布 · Coming soon` : '';
  const content = $('#policy-content'); content.replaceChildren();
  const loading = document.createElement('p'); loading.textContent = '正在加载说明…'; content.append(loading);
  dialog.showModal(); dialog.scrollTop = 0;
  try {
    const policy = await getPolicy(); content.replaceChildren();
    const date = document.createElement('small'); date.textContent = `说明版本：${policy.version}`; content.append(date);
    for (const [heading, text] of policy.sections) {
      const section = document.createElement('section'), h = document.createElement('h3'), p = document.createElement('p');
      h.textContent = heading; p.textContent = text; section.append(h,p); content.append(section);
    }
    const link = document.createElement('a'); link.href = 'https://www.bilibili.com/blackboard/protocal/licence.html'; link.target='_blank'; link.rel='noopener noreferrer'; link.textContent='查看哔哩哔哩用户使用协议 ↗'; content.append(link);
    $('#confirm-download').dataset.loaded = 'true';
  } catch (error) { content.textContent = error.message; $('#confirm-download').dataset.loaded='false'; }
}
document.querySelectorAll('[data-policy]').forEach(button => button.addEventListener('click', () => openPolicy()));
document.querySelectorAll('[data-download]').forEach(button => button.addEventListener('click', () => openPolicy(button.dataset.download)));
$('.close-dialog').addEventListener('click', () => $('#policy-dialog').close());
$('#policy-close').addEventListener('click', () => $('#policy-dialog').close());
$('#download-accepted').addEventListener('change', event => { $('#confirm-download').disabled = !event.target.checked || $('#confirm-download').dataset.loaded !== 'true'; });
$('#confirm-download').addEventListener('click', () => {
  $('#download-availability').textContent = `${platform} · Coming soon。当前还没有公开安装包，请关注 GitHub 后续发布。`;
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
    const response = await fetch('/api/feedback', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data), signal:AbortSignal.timeout(15000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '提交失败，请稍后重试。');
    status.textContent = `${result.message} 反馈编号：${result.id}。请保留编号，便于后续联系。`;
    form.reset(); updateCategory();
  } catch (error) {
    status.className='error'; status.textContent = error.name === 'TimeoutError' ? '请求超时，反馈可能已收到；请稍后确认，避免重复提交。' : error.message || '网络连接失败，请稍后重试。';
  } finally { button.disabled=false; button.textContent='提交反馈 ↗'; }
});
