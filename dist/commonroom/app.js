import { request, loadSaved, saveLocal } from './client.js';
import { $, $$, action, avatar, card, el, field, initials, reactionEmoji } from './ui.js';
import { createThreads } from './threads.js';

const view = $('#workspace');
const dialog = $('#dialog');
const stream = $('#stream');
const composer = $('#composer');
const input = $('#message-input');
const state = {
  user: null, spaces: null, servers: [], server: null, channel: null,
  rows: new Map(), cursor: null, before: null, older: false, navigation: 0,
  saved: null, replying: null, sending: new Set(),
  pane: 'chat', syncing: false, reachedBottom: true, lastRead: 0, loading: false,
};
let starting = false;
let toastTimer;
let dialogVersion = 0;
const boards = new Map();

const localPreview = document.documentElement.hasAttribute('data-local-preview');
let temporaryPreview = false;
const deviceTheme = matchMedia('(prefers-color-scheme: dark)');
const embedded = new URLSearchParams(location.search).has('embedded');
function updateTheme() {
  let theme = localPreview || deviceTheme.matches ? 'dark' : 'light';
  if (localPreview) {
    try { theme = localStorage.getItem('ram-for-bic-theme') || theme; }
    catch { /* The preview can still open without browser storage. */ }
  }
  if (embedded) {
    try { theme = window.parent.document.documentElement.dataset.theme || theme; }
    catch { /* Device theme remains available outside the campaign origin. */ }
  }
  document.documentElement.dataset.theme = theme;
  $('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
}
if (embedded) {
  try {
    new MutationObserver(updateTheme).observe(window.parent.document.documentElement, { attributeFilter: ['data-theme'] });
  } catch { /* The standalone theme has no parent dependency. */ }
}
deviceTheme.addEventListener('change', updateTheme);
updateTheme();

function notice(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 6500);
}

function status(element, message, error = false) {
  element.textContent = message;
  element.dataset.error = String(error);
}

function connected(online, label) {
  const bar = $('#connection');
  bar.dataset.state = online ? 'online' : 'offline';
  const heading = $('#connection-label');
  const connectionLabel = localPreview && online ? (temporaryPreview ? 'Temporary demo' : 'Local demo') : label;
  if (heading.textContent !== connectionLabel) heading.textContent = connectionLabel;
  $('[data-action="retry-connection"]', bar).hidden = online;
}

function remember() {
  if (!state.user || !saveLocal(state.user.id, state.saved)) notice('Browser storage is unavailable. Keep this tab open to retain your draft.');
}

function pane(name) {
  state.pane = name;
  view.dataset.pane = name;
  const active = boards.has(name) || name === 'people' ? name
    : name === 'rooms' || state.server?.id === state.spaces?.classes ? 'classes' : 'global';
  for (const button of $$('nav button[data-action]')) {
    if (!['global', 'classes', 'issues', 'help', 'people'].includes(button.dataset.action)) continue;
    button.toggleAttribute('aria-current', button.dataset.action === active);
    if (button.dataset.action === active) button.setAttribute('aria-current', 'true');
  }
  if (name === 'chat') updateRead().catch(connectionError);
}

function connectionError(error) {
  if (error.status === 401) return reconnectGuest();
  connected(false, 'Offline');
}

function channelLabel(channel) {
  if (channel.id === state.spaces.global) return 'Global chat';
  if (channel.id === state.spaces.classA) return 'Class A';
  if (channel.id === state.spaces.classB) return 'Class B';
  return channel.name === 'announcements' ? 'Announcements' : channel.name;
}

function replaceControls(root, nodes) {
  const focused = root.contains(document.activeElement) ? document.activeElement : null;
  const key = focused?.dataset;
  root.replaceChildren(...nodes);
  if (key?.action) {
    $$('button', root).find((button) => (
      button.dataset.action === key.action && button.dataset.id === key.id && button.dataset.emoji === key.emoji
    ))?.focus({ preventScroll: true });
  }
}

let sidebarSignature, memberSignature;

function renderNavigation() {
  const selected = state.channel;
  if (selected) {
    $('#channel-title').textContent = channelLabel(selected);
    $('#channel-topic').textContent = selected.topic;
    input.placeholder = 'Write to ' + channelLabel(selected);
  }
  const sidebarKey = JSON.stringify([state.servers.map((server) => server.channels), selected?.id]);
  if (sidebarKey !== sidebarSignature) {
    sidebarSignature = sidebarKey;
    const groups = state.servers.map((server) => {
      const section = el('section', 'room-group');
      const title = el('h3', 'room-group-title', server.id === state.spaces.classes ? 'Class rooms' : 'BIC Campus');
      if (server.id === state.spaces.classes) {
        title.id = 'class-heading';
        title.tabIndex = -1;
      }
      section.append(title);
      for (const channel of server.channels) {
        const name = channelLabel(channel);
        const button = action('', 'channel', channel.id, 'channel-button' + (channel.unread ? ' unread' : ''));
        const icon = el('span', 'room-symbol', channel.id === state.spaces.global ? '◉' : channel.readOnly ? '✦' : '#');
        icon.setAttribute('aria-hidden', 'true');
        button.append(icon, el('span', 'channel-name', name));
        if (channel.unread) button.append(el('span', 'count', channel.unread));
        if (channel.id === selected?.id) button.setAttribute('aria-current', 'true');
        button.title = name;
        button.setAttribute('aria-label', name + (channel.unread ? ', ' + channel.unread + ' unread' : ''));
        section.append(button);
      }
      return section;
    });
    replaceControls($('#channel-list'), groups);
  }
  const members = state.server?.members || [];
  const memberKey = JSON.stringify(members);
  if (memberKey !== memberSignature) {
    memberSignature = memberKey;
    const items = members.map((member) => {
      const item = el('li');
      const info = el('div', 'member-info');
      info.append(el('strong', '', member.name), el('small', '', member.role === 'owner' ? 'Space steward' : 'Guest'));
      item.append(avatar(member.name), info);
      return item;
    });
    replaceControls($('#member-list'), items.length ? items : [el('li', 'muted', 'Nobody to show yet.')]);
  }
}

function renderMessages(keepBottom = state.reachedBottom) {
  const messages = [...state.rows.values()].sort((a, b) => a.seq - b.seq);
  const queued = state.saved.queued.filter((item) => item.channel === state.channel?.id);
  const children = messages.map((message) => card(message, state.user, state.server.role));
  for (const item of queued) {
    if (state.rows.has(item.id)) continue;
    children.push(card({
      id: item.id, author: state.user.name, authorId: state.user.id, text: item.text, createdAt: item.createdAt,
      replyToId: item.replyToId, replyText: item.replyText, replyAuthor: item.replyAuthor,
    }, state.user, state.server.role, { ...item, sending: state.sending.has(item.id) }));
  }
  const oldTop = stream.scrollTop;
  replaceControls($('#messages'), children);
  $('#older-button').hidden = !state.older;
  const empty = state.channel.readOnly ? 'No announcements yet.' : 'No messages here yet. Start the conversation.';
  $('#messages-status').textContent = children.length ? '' : state.loading ? 'Loading messages…' : empty;
  stream.scrollTop = keepBottom ? stream.scrollHeight : oldTop;
}

function selectedStill(navigation, user = state.user?.id) {
  return navigation === state.navigation && state.user?.id === user;
}

function updateReply() {
  const box = $('#reply-preview');
  box.hidden = !state.replying;
  $('span', box).textContent = state.replying ? 'Replying to ' + state.replying.author + ' · ' + state.replying.text.slice(0, 110) : '';
}

async function updateRead() {
  if (!state.channel || !state.rows.size || document.hidden || !state.reachedBottom || boards.has(state.pane)
    || matchMedia('(max-width: 720px)').matches && state.pane !== 'chat') return;
  const target = [...state.rows.values()].reduce((highest, row) => Math.max(highest, row.seq), 0);
  if (target <= state.lastRead) return;
  const version = state.navigation;
  await request('/channels/' + state.channel.id + '/read', 'POST', { seq: target });
  if (selectedStill(version)) {
    state.lastRead = Math.max(state.lastRead, target);
    if (state.channel.unread) {
      state.channel.unread = 0;
      renderNavigation();
    }
  }
}

function merge(messages) {
  let changed = false;
  for (const row of messages) {
    if (JSON.stringify(state.rows.get(row.id)) !== JSON.stringify(row)) changed = true;
    state.rows.set(row.id, row);
  }
  const pending = state.saved.queued.filter((item) => item.channel !== state.channel?.id || !state.rows.has(item.id));
  if (pending.length !== state.saved.queued.length) {
    state.saved.queued = pending;
    remember();
    changed = true;
  }
  return changed;
}

async function openChannel(channelId, focus = true, jump = null) {
  const server = state.servers.find((space) => space.channels.some((room) => room.id === channelId));
  const channel = server?.channels.find((room) => room.id === channelId);
  if (!channel) return;
  for (const board of boards.values()) board.close();
  state.server = server;
  const version = ++state.navigation;
  state.channel = channel;
  state.rows = new Map();
  state.cursor = null;
  state.before = null;
  state.older = false;
  state.lastRead = 0;
  state.loading = true;
  state.reachedBottom = !jump;
  state.replying = null;
  input.value = state.saved.drafts[channelId] || '';
  updateReply();
  $('#conversation').hidden = false;
  composer.hidden = Boolean(channel.readOnly);
  state.saved.channel = channelId;
  remember();
  pane('chat');
  renderNavigation();
  renderMessages();
  if (focus) $('#channel-title').focus({ preventScroll: true });
  try {
    const feed = await request('/channels/' + channelId + '/messages');
    if (!selectedStill(version)) return;
    state.loading = false;
    merge(feed.messages);
    state.cursor = feed.cursor;
    state.before = feed.messages[0]?.seq ?? null;
    state.older = feed.hasOlder;
    if (jump) {
      while (!state.rows.has(jump.id) && state.older && selectedStill(version)) await loadOlder(false);
    }
    if (!selectedStill(version)) return;
    renderMessages(!jump);
    if (jump) {
      const result = $$('[data-message]', stream).find((item) => item.dataset.message === jump.id);
      if (result) {
        result.scrollIntoView({ block: 'center' });
        result.focus({ preventScroll: true });
      } else notice('That search result is no longer available.');
    } else {
      await updateRead();
    }
  } catch (error) {
    if (!selectedStill(version)) return;
    state.loading = false;
    status($('#messages-status'), error.message, true);
    connectionError(error);
  }
}

async function loadOlder(redraw = true) {
  if (!state.channel || !state.older || !state.before) return;
  const version = state.navigation;
  const before = state.before;
  const oldHeight = stream.scrollHeight;
  const oldTop = stream.scrollTop;
  const feed = await request('/channels/' + state.channel.id + '/messages?before=' + before);
  if (!selectedStill(version)) return;
  merge(feed.messages);
  state.before = feed.messages[0]?.seq ?? before;
  state.older = feed.hasOlder;
  if (redraw) {
    renderMessages(false);
    stream.scrollTop = oldTop + stream.scrollHeight - oldHeight;
  }
}

async function readSpaces(spaces) {
  return Promise.all([request('/servers/' + spaces.campus), request('/servers/' + spaces.classes)]);
}

async function sync() {
  if (!state.user || state.syncing) return;
  state.syncing = true;
  const version = state.navigation;
  const user = state.user.id;
  try {
    const servers = await readSpaces(state.spaces);
    if (!selectedStill(version, user)) return;
    state.servers = servers;
    const server = servers.find((space) => space.id === state.server?.id);
    if (server) state.server = server;
    const channel = server?.channels.find((room) => room.id === state.channel?.id);
    if (channel) state.channel = channel;
    renderNavigation();
    const board = boards.get(state.pane);
    if (board) {
      await board.poll();
    } else if (channel && state.cursor === null && !state.loading && state.pane === 'chat') {
      await openChannel(channel.id, false);
    } else if (channel && state.cursor !== null) {
      let changed = false, more;
      do {
        const delta = await request('/channels/' + channel.id + '/messages?cursor=' + state.cursor);
        if (!selectedStill(version, user)) return;
        state.cursor = delta.cursor;
        const visible = delta.messages.filter((row) => !state.before || row.seq >= state.before || state.rows.has(row.id));
        changed = merge(visible) || changed;
        more = delta.more;
      } while (more);
      if (changed) renderMessages();
      await updateRead();
    }
    connected(true, 'Connected');
  } catch (error) {
    if (state.user?.id === user) connectionError(error);
  } finally {
    state.syncing = false;
  }
}

async function startGuest() {
  if (starting) return;
  starting = true;
  $('#startup-retry').hidden = true;
  status($('#startup-status'), 'Opening the student space…');
  try {
    const createSession = () => request('/auth/guest', 'POST', {});
    const { user, spaces } = await (!localPreview && navigator.locks
      ? navigator.locks.request('commonroom-guest', createSession) : createSession());
    const servers = await readSpaces(spaces);
    state.user = user;
    state.spaces = spaces;
    state.servers = servers;
    state.saved = loadSaved(user.id);
    for (const [name, selector, kind] of [['issues', '#thread-view', 'issue'], ['help', '#help-view', 'help']]) {
      boards.set(name, createThreads({ root: $(selector), kind, guestId: user.id, notice, onAuthExpired: reconnectGuest }));
    }
    $('#guest-name').textContent = user.name;
    $('#account-name').textContent = user.name;
    $('#account-avatar').textContent = initials(user.name);
    $('#startup').hidden = true;
    view.hidden = false;
    renderNavigation();
    connected(true, 'Connected');
    const preferred = servers.some((server) => server.channels.some((room) => room.id === state.saved.channel))
      ? state.saved.channel : spaces.global;
    await openChannel(preferred, false);
  } catch (error) {
    state.user = null;
    view.hidden = true;
    $('#startup').hidden = false;
    status($('#startup-status'), error.message, true);
    $('#startup-retry').hidden = false;
  } finally {
    starting = false;
  }
}

function reconnectGuest() {
  if (starting) return;
  state.navigation++;
  state.user = state.channel = state.server = null;
  for (const board of boards.values()) board.close();
  if (dialog.open) dialog.close();
  view.hidden = true;
  $('#startup').hidden = false;
  return startGuest();
}

async function sendQueued(id) {
  const item = state.saved.queued.find((pending) => pending.id === id);
  if (!item || state.sending.has(id)) return;
  const user = state.user.id;
  state.sending.add(id);
  if (state.channel?.id === item.channel) renderMessages(true);
  try {
    const { message } = await request('/channels/' + item.channel + '/messages', 'POST', {
      id: item.id, text: item.text, replyToId: item.replyToId,
    });
    if (state.user?.id !== user) return;
    state.saved.queued = state.saved.queued.filter((pending) => pending.id !== id);
    if (state.channel?.id === item.channel) state.rows.set(message.id, message);
    connected(true, 'Connected');
  } catch (error) {
    if (state.user?.id !== user) return;
    item.error = error.message;
    if (!error.status || error.status >= 500) connected(false, 'Message unsent. Check your connection and retry.');
  } finally {
    state.sending.delete(id);
    if (state.user?.id === user) {
      remember();
      if (state.channel?.id === item.channel) renderMessages(true);
    }
  }
}

input.addEventListener('input', () => {
  if (!state.channel) return;
  if (input.value) state.saved.drafts[state.channel.id] = input.value;
  else delete state.saved.drafts[state.channel.id];
  remember();
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!state.channel || state.channel.readOnly) return;
  if (!input.value.trim()) {
    notice('Write a message before sending.');
    return;
  }
  const quoted = state.replying;
  const item = {
    channel: state.channel.id, id: crypto.randomUUID(), text: input.value.trim(), createdAt: Date.now(),
    replyToId: quoted?.id ?? null, replyText: quoted?.text.slice(0, 140), replyAuthor: quoted?.author,
  };
  state.saved.queued.push(item);
  delete state.saved.drafts[state.channel.id];
  remember();
  input.value = '';
  state.replying = null;
  updateReply();
  sendQueued(item.id);
});

stream.addEventListener('scroll', () => {
  const atBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 48;
  const reached = atBottom && !state.reachedBottom;
  state.reachedBottom = atBottom;
  if (reached) updateRead().catch(connectionError);
});

function displayDialog(title, content) {
  dialogVersion++;
  $('#dialog-title').textContent = title;
  $('#dialog-content').replaceChildren(...content);
  status($('#dialog-status'), '');
  if (!dialog.open) dialog.showModal();
  const focus = $('#dialog-content').querySelector('input, select, textarea, button');
  focus?.focus();
  return dialogVersion;
}

function formDialog(title, controls, label, submit, { stay = false } = {}) {
  const form = el('form');
  const confirm = el('button', 'primary', label);
  confirm.type = 'submit';
  form.append(...controls, confirm);
  const version = displayDialog(title, [form]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    confirm.disabled = true;
    status($('#dialog-status'), 'Working…');
    try {
      await submit(new FormData(form));
      if (dialogVersion !== version || !dialog.open) return;
      status($('#dialog-status'), '');
      if (!stay) dialog.close();
    } catch (error) {
      if (dialogVersion === version && dialog.open) status($('#dialog-status'), error.message, true);
      else notice(error.message);
    } finally {
      confirm.disabled = false;
    }
  });
  return form;
}

function confirmation(title, description, label, perform) {
  formDialog(title, [el('p', 'muted', description)], label, perform);
}

const searchMatches = new Map();
function searchDialog() {
  const server = state.server.id;
  const results = el('ul', 'dialog-list');
  const form = formDialog('Search messages', [field('Search this server', 'query', { max: 80 })], 'Search', async (data) => {
    const { matches } = await request('/servers/' + server + '/search?q=' + encodeURIComponent(data.get('query')));
    searchMatches.clear();
    results.replaceChildren(...(matches.length ? matches.map((match) => {
      searchMatches.set(match.id, match);
      const row = el('li');
      const button = action(match.author + ' · #' + match.channel, 'search-result', match.id, 'text-button');
      row.append(button, el('p', '', match.text.slice(0, 180)));
      return row;
    }) : [el('li', 'muted', 'No matching messages in channels you can access.')]));
  }, { stay: true });
  results.setAttribute('aria-label', 'Search results');
  form.after(results);
}

async function reaction(message, emoji) {
  const version = state.navigation;
  const active = !message.reactions?.find((item) => item.emoji === emoji)?.mine;
  const { message: result } = await request('/messages/' + message.id + '/reaction', 'PUT', { emoji, active });
  if (selectedStill(version)) {
    state.rows.set(result.id, result);
    renderMessages();
  }
}

async function rowAction(actionName, id, button) {
  const message = state.rows.get(id);
  if (actionName === 'retry-message') return sendQueued(id);
  if (actionName === 'discard-message') {
    confirmation('Discard unsent message?', 'This removes the saved retry from this browser.', 'Discard', () => {
      state.saved.queued = state.saved.queued.filter((item) => item.id !== id);
      remember();
      renderMessages();
    });
    return;
  }
  if (!message || message.deletedAt) return;
  if (actionName === 'reply') {
    state.replying = message;
    updateReply();
    input.focus();
  }
  if (actionName === 'react') {
    const choices = el('div', 'actions');
    for (const emoji of reactionEmoji) {
      const control = action(emoji, 'pick-reaction', id);
      control.dataset.emoji = emoji;
      control.setAttribute('aria-label', 'Toggle ' + emoji + ' reaction');
      choices.append(control);
    }
    displayDialog('React to message', [choices]);
  }
  if (actionName === 'pick-reaction' || actionName === 'toggle-reaction') {
    await reaction(message, button.dataset.emoji);
    if (actionName === 'pick-reaction') dialog.close();
  }
  const version = state.navigation;
  if (actionName === 'edit-message') {
    const editorUser = state.user.id;
    const editor = formDialog('Edit message', [
      field('Message', 'text', { multiline: true, max: 2000, value: state.saved.edits[id] ?? message.text }),
    ], 'Save changes', async (data) => {
      const result = await request('/messages/' + id, 'PATCH', {
        text: data.get('text'), editedAt: message.editedAt ?? null,
      });
      if (state.user?.id !== editorUser) return;
      delete state.saved.edits[id];
      remember();
      if (selectedStill(version)) {
        state.rows.set(id, result.message);
        renderMessages();
      }
      notice('Message edited.');
    });
    editor.elements.text.addEventListener('input', () => {
      if (state.user?.id !== editorUser) return;
      state.saved.edits[id] = editor.elements.text.value;
      remember();
    });
  }
  if (actionName === 'delete-message') confirmation('Remove this message?', 'The text will be removed from the conversation.', 'Remove message', async () => {
    const result = await request('/messages/' + id, 'DELETE');
    if (selectedStill(version)) {
      state.rows.set(id, result.message);
      renderMessages();
    }
    notice('Message removed.');
  });
}

async function runAction(name, id, button) {
  if (name === 'start') return startGuest();
  if (name === 'close-dialog') return dialog.close();
  if (!state.user) return;
  if (name === 'global') return openChannel(state.spaces.global);
  if (name === 'classes') {
    if (matchMedia('(max-width: 720px)').matches) pane('rooms');
    $('#class-heading')?.focus();
    return;
  }
  if (name === 'channel') return openChannel(id);
  if (boards.has(name)) {
    state.navigation++;
    $('#conversation').hidden = true;
    for (const [key, board] of boards) {
      if (key !== name) board.close();
    }
    pane(name);
    return boards.get(name).open();
  }
  if (name === 'people') {
    pane('people');
    $('#people-title').focus();
    return;
  }
  if (name === 'toggle-people') {
    const open = view.dataset.members !== 'true';
    view.dataset.members = String(open);
    $('[aria-controls="people-panel"]').setAttribute('aria-expanded', String(open));
    if (open) $('#people-title').focus();
    else $('[aria-controls="people-panel"]').focus();
    return;
  }
  if (name === 'search') return searchDialog();
  if (name === 'search-result') {
    const match = searchMatches.get(id);
    if (match) {
      dialog.close();
      await openChannel(match.channelId, true, match);
    }
    return;
  }
  if (name === 'older') {
    button.disabled = true;
    try { await loadOlder(); } finally { button.disabled = false; }
    return;
  }
  if (name === 'cancel-reply') {
    state.replying = null;
    updateReply();
    input.focus();
    return;
  }
  if (name === 'retry-connection') return sync();
  if (id) return rowAction(name, id, button);
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const { action: name, id } = button.dataset;
  runAction(name, id, button).catch((error) => {
    if (dialog.open) status($('#dialog-status'), error.message, true);
    else notice(error.message);
  });
});

if (localPreview) {
  document.addEventListener('commonroom-preview-temporary', () => {
    if (temporaryPreview) return;
    temporaryPreview = true;
    connected(true, 'Connected');
    notice('Browser storage is unavailable. Posts will last until you close or reload this tab.');
  });
  window.addEventListener('storage', (event) => {
    if (event.key === 'ram-for-bic-theme') updateTheme();
  });
}

await startGuest();
setInterval(() => { if (!document.hidden) sync(); }, 3000);
window.addEventListener('online', () => state.user ? sync() : startGuest());
window.addEventListener('offline', () => { if (state.user && !localPreview) connected(false, 'Offline'); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
