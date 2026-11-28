const $ = selector => document.querySelector(selector);
const api = '/api/v1/admin/feedback';
const login = $('#admin-login');
const logout = $('#admin-logout');
const workspace = $('#admin-workspace');
const filters = $('#admin-filters');
const list = $('#admin-list');
const detailForm = $('#admin-editor');
const detailPlaceholder = $('#admin-detail-placeholder');
const saveButton = $('#admin-save-button');
const reloadDetailButton = $('#admin-reload-detail');
const noteForm = $('#admin-note-form');
const noteSubmit = noteForm.querySelector('button[type=submit]');
const replyForm = $('#admin-reply-form');
const replySubmit = replyForm.querySelector('button[type=submit]');
const closeReason = $('#admin-close-reason');
const imageDialog = $('#admin-image-dialog');
const largeImage = $('#admin-large-image');
const compactView = matchMedia('(max-width: 720px)');
const dates = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
const statuses = { new: '待处理', in_progress: '处理中', resolved: '已解决', closed: '已关闭' };
const categories = { bug: '遇到问题', suggestion: '功能建议', copyright: '版权与权利反馈', other: '其他' };
const editable = ['title', 'category', 'message', 'status'];
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const detailPanels = ['#admin-record', '#admin-editor', '#admin-detail-actions', '#admin-collaboration'];
const byStatus = ['all', ...Object.keys(statuses)];
const environmentLabels = {
  system: '系统', systemBuild: '系统构建', deviceModel: '设备型号', architecture: '应用架构',
  webview: 'WebView', webviewPackage: 'WebView 包', apiLevel: '系统 API', largeScreen: '应用形态',
};

let selectedId = '';
let currentItem = null;
let listRequest = 0;
let detailRequest = 0;
let sessionGeneration = 0;
let currentPage = 1;
let appliedFilters = {};
const listButtons = new Map();
const editDrafts = new Map();
const noteDrafts = new Map();
const replyDrafts = new Map();
const editing = new Set();
const posting = new Set();
const replying = new Set();
let signature = '';

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text) result.textContent = text;
  return result;
}

function message(selector, text = '', tone = '') {
  const target = $(selector);
  target.textContent = text;
  target.dataset.tone = tone;
}

function feedbackLink(id = '') {
  const url = new URL('/admin/feedback', location.origin);
  if (id) url.searchParams.set('id', id);
  return url;
}

function showDetailPanels(visible) {
  for (const panel of detailPanels) $(panel).hidden = !visible;
  detailPlaceholder.hidden = visible;
}

function setFilterControls() {
  for (const button of document.querySelectorAll('[data-filter-status]')) {
    button.setAttribute('aria-pressed', String(button.dataset.filterStatus === filters.elements.status.value));
  }
  $('#admin-clear-filters').hidden = !['q', 'status', 'category', 'platform'].some(field => filters.elements[field].value) && filters.elements.sort.value === 'newest';
}

async function request(path = '', method = 'GET', body) {
  const options = { method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(api + path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || '请求未完成，请重试。');
    error.status = response.status;
    throw error;
  }
  return data;
}

function showLogin() {
  sessionGeneration++;
  listRequest++;
  detailRequest++;
  selectedId = '';
  currentItem = null;
  appliedFilters = {};
  workspace.dataset.view = 'list';
  workspace.hidden = true;
  logout.hidden = true;
  login.hidden = false;
  login.reset();
  filters.reset();
  filters.elements.status.value = '';
  setFilterControls();
  list.replaceChildren();
  listButtons.clear();
  editDrafts.clear();
  noteDrafts.clear();
  replyDrafts.clear();
  editing.clear();
  posting.clear();
  replying.clear();
  detailForm.reset();
  noteForm.reset();
  replyForm.reset();
  showDetailPanels(false);
  $('#admin-image-list').replaceChildren();
  $('#admin-original-fields').replaceChildren();
  $('#admin-note-list').replaceChildren();
  $('#admin-reply-list').replaceChildren();
  for (const id of ['#admin-record-id', '#admin-record-platform', '#admin-record-contact', '#admin-record-time']) $(id).textContent = '';
  renderSubmissionDetails({});
  $('#admin-record-time').removeAttribute('datetime');
  largeImage.removeAttribute('src');
  if (imageDialog.open) imageDialog.close();
  detailPlaceholder.hidden = false;
  message('#admin-detail-placeholder', '选择一条反馈查看详情');
  message('#admin-session-message');
  message('#admin-login-message');
}

function sessionExpired(error) {
  if (error.status !== 401) return false;
  showLogin();
  message('#admin-login-message', '登录已过期，请重新登录。', 'error');
  login.elements.username.focus();
  return true;
}

function showWorkspace() {
  const wasHidden = workspace.hidden;
  login.hidden = true;
  login.reset();
  logout.hidden = false;
  workspace.hidden = false;
  message('#admin-session-message');
  try { signature = sessionStorage.getItem('bilimusic-feedback-note-author') || ''; } catch {}
  loadFeedbackPage(wasHidden ? 1 : currentPage);
  const id = new URL(location.href).searchParams.get('id');
  if (wasHidden && id && uuid.test(id)) loadDetail(id);
}

function dateText(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? dates.format(date) : '—';
}

function feedbackPlatform(item) {
  const platform = { 'Android Large Screen': '车机 / TV', website: '网站', other: '其他' }[item.platform] || item.platform || '未知平台';
  return [platform, item.version].filter(Boolean).join(' / ');
}

function markSelection() {
  for (const [id, button] of listButtons) button.setAttribute('aria-current', String(id === selectedId));
}

function renderList(items) {
  list.replaceChildren();
  listButtons.clear();
  for (const item of items) {
    const row = node('li');
    const button = node('button', 'admin-list-button');
    button.type = 'button';
    button.addEventListener('click', () => loadDetail(item.id));
    const meta = node('span', 'admin-list-meta');
    const status = node('span', 'admin-status', statuses[item.status] || item.status);
    status.dataset.status = item.status;
    const category = node('span', 'admin-category', categories[item.category]);
    category.dataset.category = item.category;
    const date = appliedFilters.sort === 'activity' ? item.activity_at : item.created_at;
    const timestamp = node('time', 'admin-list-activity', dateText(date));
    timestamp.dateTime = date || '';
    meta.append(status, category, node('span', 'admin-list-platform', feedbackPlatform(item)), timestamp);
    const indicators = [item.image_count && `${item.image_count} 张图`, item.note_count && `${item.note_count} 条备注`].filter(Boolean);
    if (indicators.length) meta.append(node('span', 'admin-list-attachments', indicators.join(' · ')));
    button.append(node('span', 'admin-list-title', item.title), meta);
    row.append(button);
    list.append(row);
    listButtons.set(item.id, button);
  }
  markSelection();
}

async function loadFeedbackPage(page, resetScroll = false) {
  const generation = ++listRequest;
  const query = { ...appliedFilters, page: String(page) };
  $('#admin-pagination').hidden = true;
  message('#admin-count', '正在加载反馈…');
  try {
    const result = await request('', 'POST', query);
    if (generation !== listRequest) return;
    const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
    currentPage = result.page;
    if (currentPage > pages) return loadFeedbackPage(pages);
    renderList(result.items);
    if (resetScroll) list.scrollTop = 0;
    for (const status of byStatus) {
      const counter = $(`[data-status-count="${status}"]`);
      counter.textContent = result.counts?.[status] ?? '–';
    }
    message('#admin-count', result.total ? `${result.total} 条反馈` : '未找到符合条件的反馈');
    $('#admin-page-number').textContent = `${currentPage} / ${pages}`;
    $('#admin-prev').disabled = currentPage <= 1;
    $('#admin-next').disabled = currentPage >= pages;
    $('#admin-pagination').hidden = pages <= 1;
  } catch (error) {
    if (generation !== listRequest || sessionExpired(error)) return;
    message('#admin-count', error.message, 'error');
  }
}

function renderMessages(kind, entries = []) {
  const history = $(`#admin-${kind}-list`);
  history.replaceChildren();
  $(`#admin-${kind}-empty`).hidden = entries.length > 0;
  for (const note of entries) {
    const row = node('li', 'admin-note');
    const meta = node('div', 'admin-note-meta');
    const time = node('time', '', dateText(note.created_at));
    if (note.created_at) time.dateTime = note.created_at;
    if (note.author) meta.append(node('span', 'admin-note-author', note.author));
    meta.append(time);
    row.append(meta, node('p', 'admin-note-body', note.body));
    history.append(row);
  }
}

function mergeMessages(first = [], second = []) {
  const notes = new Map([...first, ...second].map(note => [note.id, note]));
  return [...notes.values()].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) ||
    a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

function renderImages(item) {
  const images = item.images || [];
  const imageList = $('#admin-image-list');
  imageList.replaceChildren();
  $('#admin-images').hidden = images.length === 0;
  for (const [index, image] of images.entries()) {
    const address = `${api}/${encodeURIComponent(item.id)}/images/${encodeURIComponent(image.id)}`;
    const row = node('li');
    const button = node('button', 'admin-image-thumb');
    const label = `截图 ${index + 1}`;
    const preview = node('img');
    preview.src = address;
    preview.alt = label;
    button.type = 'button';
    button.setAttribute('aria-label', `放大${label}`);
    button.append(preview);
    button.addEventListener('click', () => {
      $('#admin-image-title').textContent = label;
      largeImage.src = address;
      largeImage.alt = label;
      imageDialog.showModal();
    });
    row.append(button);
    imageList.append(row);
  }
}

function renderOriginal(item) {
  const content = $('#admin-original-fields');
  content.replaceChildren();
  for (const field of ['category', 'title', 'message']) {
    const original = item['original_' + field];
    if (typeof original !== 'string' || original === item[field]) continue;
    content.append(node('p', '', field === 'category' ? categories[original] || original : original));
  }
  const originalSection = $('#admin-original');
  originalSection.hidden = content.childElementCount === 0;
  originalSection.open = false;
}

function renderSubmissionDetails(item) {
  const replyEmail = $('#admin-record-reply-email');
  const address = $('#admin-record-email');
  replyEmail.hidden = !item.contact_email;
  address.textContent = item.contact_email || '';
  address.title = address.textContent;
  replyEmail.parentElement.classList.toggle('admin-record-meta-with-email', !replyEmail.hidden);
  const account = $('#admin-record-account');
  account.hidden = !item.bilibili_uid;
  account.parentElement.classList.toggle('admin-record-meta-with-uid', !account.hidden);
  $('#admin-record-uid').textContent = item.bilibili_uid || '';

  const values = $('#admin-environment-values');
  values.replaceChildren();
  for (const [field, label] of Object.entries(environmentLabels)) {
    const value = item.environment?.[field];
    if (value == null) continue;
    const row = node('div');
    const display = typeof value === 'boolean' ? (value ? '车机 / TV' : '普通版') : String(value);
    row.append(node('dt', '', label), node('dd', '', display));
    values.append(row);
  }
  $('#admin-environment').hidden = !values.childElementCount;
}

function isEdited() {
  return currentItem && editable.some(field => detailForm.elements[field].value !== currentItem[field]);
}

function rememberDraft() {
  if (!currentItem) return;
  if (isEdited()) {
    const values = Object.fromEntries(editable.map(field => [field, detailForm.elements[field].value]));
    values.reply = detailForm.elements.reply.value;
    const previous = editDrafts.get(currentItem.id);
    const version = previous ? previous.version : currentItem.updated_at ?? null;
    editDrafts.set(currentItem.id, { values, version });
  } else editDrafts.delete(currentItem.id);
}

function updateSaveButton() {
  const busy = editing.has(selectedId);
  for (const field of editable) detailForm.elements[field].disabled = busy;
  const needsReason = currentItem?.tracked && currentItem.status !== 'closed' && detailForm.elements.status.value === 'closed';
  closeReason.hidden = !needsReason;
  detailForm.elements.reply.required = Boolean(needsReason);
  detailForm.elements.reply.disabled = busy || !needsReason;
  saveButton.disabled = busy || !isEdited() || !reloadDetailButton.hidden;
  saveButton.textContent = needsReason ? '关闭并发送回复' : '保存修改';
}

function updateNoteButton() {
  const busy = posting.has(selectedId);
  for (const field of ['author', 'body']) noteForm.elements[field].disabled = busy;
  noteSubmit.disabled = busy || !currentItem || !noteForm.elements.body.value.trim();
}

function updateReplyButton() {
  const busy = replying.has(selectedId);
  replyForm.elements.body.disabled = busy;
  replySubmit.disabled = busy || !currentItem?.tracked || !replyForm.elements.body.value.trim();
}

function editConflict() {
  reloadDetailButton.hidden = false;
  message('#admin-save-message', '同事已更新这条反馈。你的草稿仍保留在表单中。', 'error');
  updateSaveButton();
}

function renderDetail(item) {
  if (currentItem?.id === item.id) {
    item.notes = mergeMessages(currentItem.notes, item.notes);
    item.replies = mergeMessages(currentItem.replies, item.replies);
  }
  currentItem = item;
  $('#admin-record-heading').textContent = item.title;
  $('#admin-record-id').textContent = item.id;
  $('#admin-record-platform').textContent = feedbackPlatform(item);
  $('#admin-record-contact').textContent = item.contact || '未填写';
  renderSubmissionDetails(item);
  const status = $('#admin-record-status');
  status.textContent = statuses[item.status] || item.status;
  status.dataset.status = item.status;
  status.hidden = false;
  const category = $('#admin-record-category');
  category.textContent = categories[item.category] || item.category;
  category.dataset.category = item.category;
  category.hidden = false;
  const time = $('#admin-record-time');
  time.textContent = dateText(item.created_at);
  time.dateTime = item.created_at || '';
  const statusTime = $('#admin-status-time');
  statusTime.hidden = !item.status_changed_at;
  statusTime.dateTime = item.status_changed_at || '';
  statusTime.textContent = item.status_changed_at
    ? `${item.status === 'closed' || item.status === 'resolved' ? '结案于' : '状态更新于'} ${dateText(item.status_changed_at)}`
    : '';
  for (const field of editable) detailForm.elements[field].value = item[field];
  detailForm.elements.reply.value = '';
  renderOriginal(item);
  renderImages(item);
  renderMessages('note', item.notes);
  $('#admin-replies').hidden = !item.tracked;
  renderMessages('reply', item.replies);
  showDetailPanels(true);
  message('#admin-save-message');
  const draft = editDrafts.get(item.id);
  reloadDetailButton.hidden = true;
  if (draft) {
    for (const field of editable) detailForm.elements[field].value = draft.values[field];
    detailForm.elements.reply.value = draft.values.reply || '';
    if (draft.version !== (item.updated_at ?? null)) editConflict();
  }
  updateSaveButton();
  updateNoteButton();
  updateReplyButton();
}

async function loadDetail(id, { reload = false } = {}) {
  workspace.dataset.view = 'detail';
  history.replaceState(null, '', feedbackLink(id));
  if (selectedId === id && currentItem && !reload) return;
  if (!reload) rememberDraft();
  const generation = ++detailRequest;
  selectedId = id;
  currentItem = null;
  showDetailPanels(false);
  $('#admin-detail-scroll').scrollTop = 0;
  noteForm.elements.author.value = signature;
  noteForm.elements.body.value = noteDrafts.get(id) || '';
  replyForm.elements.body.value = replyDrafts.get(id) || '';
  markSelection();
  message('#admin-save-message');
  message('#admin-note-message');
  message('#admin-reply-message');
  message('#admin-detail-placeholder', '正在加载详情…');
  try {
    const { item } = await request('/' + encodeURIComponent(id));
    if (generation !== detailRequest) return;
    renderDetail(item);
    if (compactView.matches && workspace.dataset.view === 'detail') $('#admin-record-heading').focus({ preventScroll: true });
  } catch (error) {
    if (generation !== detailRequest || sessionExpired(error)) return;
    message('#admin-detail-placeholder', error.message, 'error');
  }
}

filters.addEventListener('submit', event => {
  event.preventDefault();
  appliedFilters = Object.fromEntries(new FormData(filters));
  appliedFilters.q = appliedFilters.q.trim();
  setFilterControls();
  loadFeedbackPage(1, true);
});
filters.addEventListener('change', event => {
  if (event.target.matches('select')) filters.requestSubmit();
});
filters.elements.q.addEventListener('input', setFilterControls);
for (const button of document.querySelectorAll('[data-filter-status]')) {
  button.addEventListener('click', () => {
    filters.elements.status.value = button.dataset.filterStatus;
    filters.requestSubmit();
  });
}
$('#admin-clear-filters').addEventListener('click', () => {
  filters.reset();
  filters.elements.status.value = '';
  filters.requestSubmit();
  filters.elements.q.focus();
});
$('#admin-prev').addEventListener('click', () => loadFeedbackPage(currentPage - 1, true));
$('#admin-next').addEventListener('click', () => loadFeedbackPage(currentPage + 1, true));
$('#admin-back').addEventListener('click', () => {
  workspace.dataset.view = 'list';
  history.replaceState(null, '', feedbackLink());
  (listButtons.get(selectedId) || filters.elements.q).focus();
});

async function refreshDetail() {
  if (!currentItem || editing.has(selectedId) || posting.has(selectedId) || replying.has(selectedId)) return;
  rememberDraft();
  const generation = ++detailRequest;
  try {
    const { item } = await request('/' + encodeURIComponent(selectedId));
    if (generation === detailRequest) renderDetail(item);
  } catch (error) {
    if (generation !== detailRequest || sessionExpired(error)) return;
    message('#admin-save-message', error.message, 'error');
  }
}

$('#admin-refresh').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try { await Promise.all([loadFeedbackPage(currentPage), refreshDetail()]); }
  finally { button.disabled = false; }
});
reloadDetailButton.addEventListener('click', () => {
  editDrafts.delete(selectedId);
  loadDetail(selectedId, { reload: true });
});

async function copy(value, label) {
  try {
    await navigator.clipboard.writeText(value);
    message('#admin-copy-status', label, 'success');
  } catch {
    message('#admin-copy-status', '无法复制，可从页面手动选择。', 'error');
  }
}

$('#admin-copy-id').addEventListener('click', () => {
  if (currentItem) copy(currentItem.id, '已复制反馈编号');
});
$('#admin-copy-uid').addEventListener('click', () => {
  if (currentItem?.bilibili_uid) copy(currentItem.bilibili_uid, '已复制 B 站 UID');
});
$('#admin-copy-email').addEventListener('click', () => {
  if (currentItem?.contact_email) copy(currentItem.contact_email, '已复制回复邮箱');
});
$('#admin-copy-link').addEventListener('click', () => {
  if (currentItem) copy(feedbackLink(currentItem.id).href, '已复制反馈链接');
});

document.addEventListener('keydown', event => {
  if (event.key !== '/' || event.altKey || event.ctrlKey || event.metaKey || workspace.hidden || imageDialog.open ||
      event.target.closest('form, [contenteditable]') || (compactView.matches && workspace.dataset.view === 'detail')) return;
  event.preventDefault();
  filters.elements.q.focus();
});

detailForm.addEventListener('input', () => {
  if (reloadDetailButton.hidden) message('#admin-save-message');
  rememberDraft();
  updateSaveButton();
});
detailForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentItem || saveButton.disabled) return;
  const id = currentItem.id;
  const body = { ...Object.fromEntries(new FormData(detailForm)), expected_updated_at: currentItem.updated_at ?? null };
  const session = sessionGeneration;
  editing.add(id);
  updateSaveButton();
  message('#admin-save-message', '正在保存…');
  try {
    const { item } = await request('/' + encodeURIComponent(id), 'PATCH', body);
    if (session !== sessionGeneration) return;
    editDrafts.delete(id);
    if (id === currentItem?.id) {
      renderDetail(item);
      message('#admin-save-message', '已保存', 'success');
    }
    loadFeedbackPage(currentPage);
  } catch (error) {
    if (session !== sessionGeneration || sessionExpired(error) || id !== currentItem?.id) return;
    if (error.status === 409) editConflict();
    else message('#admin-save-message', error.message, 'error');
  } finally {
    if (session === sessionGeneration) {
      editing.delete(id);
      updateSaveButton();
    }
  }
});

noteForm.addEventListener('input', event => {
  if (event.target === noteForm.elements.author) {
    signature = event.target.value;
    try { sessionStorage.setItem('bilimusic-feedback-note-author', signature); } catch {}
  }
  if (selectedId) noteDrafts.set(selectedId, noteForm.elements.body.value);
  message('#admin-note-message');
  updateNoteButton();
});
noteForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentItem || noteSubmit.disabled) return;
  const id = currentItem.id;
  const session = sessionGeneration;
  const body = Object.fromEntries(new FormData(noteForm));
  posting.add(id);
  updateNoteButton();
  message('#admin-note-message', '正在添加…');
  try {
    const { note } = await request('/' + encodeURIComponent(id) + '/notes', 'POST', body);
    if (session !== sessionGeneration) return;
    noteDrafts.delete(id);
    if (id === currentItem?.id) {
      currentItem.notes = mergeMessages(currentItem.notes, [note]);
      renderMessages('note', currentItem.notes);
      noteForm.elements.body.value = '';
      message('#admin-note-message', '已添加备注', 'success');
    }
    loadFeedbackPage(currentPage);
  } catch (error) {
    if (session !== sessionGeneration || sessionExpired(error) || id !== currentItem?.id) return;
    message('#admin-note-message', error.message, 'error');
  } finally {
    if (session === sessionGeneration) {
      posting.delete(id);
      updateNoteButton();
    }
  }
});

replyForm.addEventListener('input', () => {
  if (selectedId) replyDrafts.set(selectedId, replyForm.elements.body.value);
  message('#admin-reply-message');
  updateReplyButton();
});
replyForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentItem?.tracked || replySubmit.disabled) return;
  const id = currentItem.id;
  const session = sessionGeneration;
  const body = replyForm.elements.body.value;
  replying.add(id);
  updateReplyButton();
  message('#admin-reply-message', '正在发送…');
  try {
    const { reply } = await request('/' + encodeURIComponent(id) + '/replies', 'POST', { body });
    if (session !== sessionGeneration) return;
    replyDrafts.delete(id);
    if (id === currentItem?.id) {
      currentItem.replies = mergeMessages(currentItem.replies, [reply]);
      renderMessages('reply', currentItem.replies);
      replyForm.elements.body.value = '';
      message('#admin-reply-message', '已发送回复', 'success');
    }
    loadFeedbackPage(currentPage);
  } catch (error) {
    if (session !== sessionGeneration || sessionExpired(error) || id !== currentItem?.id) return;
    message('#admin-reply-message', error.message, 'error');
  } finally {
    if (session === sessionGeneration) {
      replying.delete(id);
      updateReplyButton();
    }
  }
});

login.addEventListener('submit', async event => {
  event.preventDefault();
  const button = login.querySelector('button[type=submit]');
  button.disabled = true;
  message('#admin-login-message', '正在登录…');
  try {
    await request('/session', 'POST', Object.fromEntries(new FormData(login)));
    showWorkspace();
    if (workspace.dataset.view === 'list') filters.elements.q.focus();
  } catch (error) {
    message('#admin-login-message', error.message, 'error');
  } finally {
    login.elements.password.value = '';
    button.disabled = false;
  }
});

logout.addEventListener('click', async () => {
  logout.disabled = true;
  try {
    await request('/session', 'DELETE');
    showLogin();
    login.elements.username.focus();
  } catch (error) {
    if (!sessionExpired(error)) message('#admin-session-message', error.message, 'error');
  } finally {
    logout.disabled = false;
  }
});

$('#admin-image-close').addEventListener('click', () => imageDialog.close());
imageDialog.addEventListener('close', () => largeImage.removeAttribute('src'));

async function checkSession() {
  try {
    await request('/session');
    showWorkspace();
  } catch (error) {
    showLogin();
    if (error.status !== 401) message('#admin-login-message', error.message, 'error');
  }
}

window.addEventListener('pageshow', event => { if (event.persisted) checkSession(); });
setFilterControls();
checkSession();
