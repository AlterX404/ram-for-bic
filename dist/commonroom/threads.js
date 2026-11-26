import { request } from './client.js';
import { avatar, el, field, readableTime, newId } from './ui.js';

const scopes = [
  ['campus', 'Campus'],
  ['class-a', 'Class A'],
  ['class-b', 'Class B'],
];
const scopeNames = Object.fromEntries(scopes);

function button(label, className, activate) {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', activate);
  return node;
}

function loadDrafts(storageKey) {
  try {
    const data = JSON.parse(localStorage.getItem(storageKey));
    return { thread: data?.thread ?? {}, replies: data?.replies ?? {} };
  } catch {
    return { thread: {}, replies: {} };
  }
}

function labelScope(scope) {
  return scopeNames[scope] ?? 'Campus';
}

function showTime(createdAt) {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return el('span');
  const node = el('time', '', readableTime(createdAt));
  node.dateTime = date.toISOString();
  return node;
}

function count(number, singular, plural = singular + 's') {
  return number + ' ' + (number === 1 ? singular : plural);
}

function header(title, summary) {
  const section = el('header', 'thread-bar');
  const words = el('div', 'thread-bar__heading');
  const heading = el('h1', 'thread-title', title);
  heading.tabIndex = -1;
  words.append(heading);
  if (summary) words.append(el('p', 'thread-subtitle', summary));
  section.append(words);
  return { section, heading };
}

function formMessage() {
  const message = el('p', 'thread-form-status');
  message.setAttribute('role', 'status');
  message.hidden = true;
  return message;
}

function say(message, value, error = false) {
  message.textContent = value;
  message.dataset.error = String(error);
  message.hidden = !value;
}

function issuePreview(issue, activate, showStances) {
  const item = el('li');
  const preview = button('', 'thread-card', () => activate(issue.id));
  preview.dataset.threadKey = issue.id;
  const main = el('span', 'thread-card__heading');
  main.append(el('strong', '', issue.title), el('span', 'thread-scope', labelScope(issue.scope)));
  const meta = el('span', 'thread-card__meta');
  meta.append(el('span', '', issue.author), showTime(issue.createdAt));
  const stats = el('span', 'thread-card__stats');
  stats.append(el('span', '', count(issue.replyCount, 'response')));
  if (showStances) stats.append(
    el('span', '', count(issue.agreeCount, 'agree', 'agree')),
    el('span', '', count(issue.disagreeCount, 'disagree', 'disagree')),
  );
  preview.append(main, el('span', 'thread-card__excerpt', issue.text), meta, stats);
  item.append(preview);
  return item;
}

export function createThreads({ root, guestId, kind = 'issue', notice = () => {}, onAuthExpired = () => {} }) {
  root.classList.add('thread-view');
  root.hidden = true;
  const help = kind === 'help';
  const endpoint = help ? '/help' : '/threads';
  const storageKey = (help ? 'commonroom:help-drafts:v1' : 'commonroom:thread-drafts:v1') + (guestId ? ':' + guestId : '');
  const drafts = loadDrafts(storageKey);
  let storageWarned = false;
  let active = false;
  let screen = '';
  let scope = 'all';
  let selected = null;
  let list = null;
  let detail = null;
  let ui = {};
  let revision = 0;
  let pendingRead = null;
  let writeId = 0;
  let mutations = 0;
  let focusThread = null;

  function saveDrafts() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(drafts));
    } catch {
      if (!storageWarned) notice('Drafts will stay in this tab. Browser storage is unavailable.');
      storageWarned = true;
    }
  }

  function setScreen(name, content, focus) {
    revision++;
    screen = name;
    root.replaceChildren(...content);
    if (focus) root.querySelector('h1')?.focus({ preventScroll: true });
  }

  function networkStatus() {
    const bar = el('div', 'thread-network');
    const message = el('p');
    message.setAttribute('role', 'status');
    bar.append(message, button('Retry', 'thread-link', refresh));
    bar.hidden = true;
    return { bar, message };
  }

  function networkError(error) {
    if (error.status === 401) Promise.resolve().then(onAuthExpired).catch(() => {});
    if (!ui.network) return;
    ui.network.bar.hidden = false;
    ui.network.message.textContent = error.message;
    if (screen === 'list' && list === null) ui.state.textContent = help ? 'Questions could not load.' : 'Threads could not load.';
    if (screen === 'detail' && detail === null) ui.body.textContent = 'This discussion could not load.';
  }

  function listView(focus = true) {
    selected = null;
    detail = null;
    const top = help
      ? header('Help', 'Ask a question or share practical advice with other students.')
      : header('Issue threads', 'Raise issues and hear other students’ perspectives.');
    top.section.append(button(help ? 'Ask a question' : 'New thread', 'thread-primary', composeView));
    const filters = el('div', 'thread-filters');
    filters.setAttribute('role', 'group');
    filters.setAttribute('aria-label', 'Filter threads by scope');
    for (const [value, caption] of [['all', 'All'], ...scopes]) {
      const filter = button(caption, 'thread-filter', () => {
        scope = value;
        renderList(true);
      });
      filter.dataset.scope = value;
      filters.append(filter);
    }
    const network = networkStatus();
    const scroll = el('div', 'thread-scroll');
    const state = el('p', 'thread-empty');
    const results = el('ol', 'thread-list');
    results.setAttribute('aria-label', help ? 'Help questions' : 'Issue threads');
    scroll.append(state, results);
    ui = { filters, network, scroll, state, results, signature: '' };
    setScreen('list', [top.section, filters, network.bar, scroll], focus);
    renderList();
    refresh();
  }

  function renderList(resetScroll = false) {
    for (const filter of ui.filters.children) {
      filter.setAttribute('aria-pressed', String(filter.dataset.scope === scope));
    }
    const visible = (list ?? []).filter((issue) => scope === 'all' || issue.scope === scope);
    const signature = JSON.stringify(visible);
    if (signature !== ui.signature) {
      const key = ui.results.contains(document.activeElement) ? document.activeElement.dataset.threadKey : focusThread;
      ui.results.replaceChildren(...visible.map((issue) => issuePreview(issue, detailView, !help)));
      if (key) Array.from(ui.results.querySelectorAll('[data-thread-key]'))
        .find((card) => card.dataset.threadKey === key)?.focus({ preventScroll: true });
      focusThread = null;
      ui.signature = signature;
    }
    ui.state.hidden = visible.length !== 0;
    ui.state.textContent = help
      ? (list === null ? 'Loading questions…' : scope === 'all' ? 'No questions yet. Ask the first one.' : 'No questions in this scope yet.')
      : list === null
      ? 'Loading threads…'
      : scope === 'all' ? 'No issues have been posted yet. Start with a new thread.' : 'No issues in this scope yet.';
    if (resetScroll) ui.scroll.scrollTop = 0;
  }

  function composeView() {
    const top = help
      ? header('Ask a question', 'Describe what you need so another student can help.')
      : header('Start a thread', 'Keep the title short and describe what would help.');
    top.section.prepend(button('Back', 'thread-link', () => listView()));
    const scroll = el('div', 'thread-scroll');
    const form = el('form', 'thread-form');
    const draft = drafts.thread;
    const scopeField = field('Scope', 'scope', { choices: scopes, value: draft.scope ?? (scope === 'all' ? 'campus' : scope) });
    const title = field('Title', 'title', { max: 100, value: draft.title ?? '' });
    const text = field(help ? 'Question details' : 'Issue details', 'text', { max: 2400, multiline: true, value: draft.text ?? '' });
    const submit = el('button', 'thread-primary', help ? 'Post question' : 'Post thread');
    submit.type = 'submit';
    const message = formMessage();
    form.append(
      scopeField, title, text,
      el('p', 'thread-form-hint', 'Choose a scope and keep personal details out of shared threads.'),
      message, submit,
    );
    scroll.append(form);
    setScreen('compose', [top.section, scroll], false);
    form.elements.title.minLength = 3;
    form.elements.text.minLength = 3;
    form.elements.title.focus({ preventScroll: true });
    form.addEventListener('input', () => {
      Object.assign(draft, Object.fromEntries(new FormData(form)));
      saveDrafts();
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = {
        title: form.elements.title.value.trim(),
        text: form.elements.text.value.trim(),
        scope: form.elements.scope.value,
      };
      if (payload.title.length < 3 || payload.text.length < 3) {
        say(message, 'Add at least three characters to the title and details.', true);
        return;
      }
      if (submit.disabled || mutations > 0) return;
      const route = revision;
      const id = draft.pending ?? newId();
      draft.pending = id;
      Object.assign(draft, payload);
      saveDrafts();
      submit.disabled = true;
      say(message, 'Posting…');
      mutations++;
      writeId++;
      try {
        const { thread } = await request(endpoint, 'POST', { id, ...payload });
        if (thread.title !== payload.title || thread.text !== payload.text || thread.scope !== payload.scope) {
          delete draft.pending;
          saveDrafts();
          say(message, 'An earlier version was already posted. Your changes are still in this draft.', true);
          return;
        }
        if (draft.title === payload.title && draft.text === payload.text && draft.scope === payload.scope) {
          drafts.thread = {};
        } else {
          delete draft.pending;
        }
        saveDrafts();
        if (active && route === revision) detailView(thread.id, thread);
        else notice(help ? 'Question posted.' : 'Thread posted.');
      } catch (error) {
        if (error.status === 401) Promise.resolve().then(onAuthExpired).catch(() => {});
        if (error.status === 409) {
          delete draft.pending;
          saveDrafts();
          say(message, 'An earlier version may already be posted in a different scope. Your draft is saved here.', true);
        } else {
          say(message, error.message + ' Your draft is saved here.', true);
        }
        submit.textContent = 'Retry post';
      } finally {
        mutations--;
        writeId++;
        submit.disabled = false;
        refresh();
      }
    });
  }

  function detailView(threadId, posted) {
    selected = threadId;
    const cached = posted ?? list?.find((thread) => thread.id === threadId);
    detail = null;
    const top = header(cached?.title ?? 'Thread');
    top.section.prepend(button('Back', 'thread-link', () => {
      focusThread = threadId;
      listView();
    }));
    const network = networkStatus();
    const scroll = el('div', 'thread-scroll');
    const original = el('article', 'thread-original');
    const scopeTag = el('span', 'thread-scope');
    const originalMeta = el('div', 'thread-author');
    const body = el('p', 'thread-body', help ? 'Loading question…' : 'Loading issue…');
    const stance = el('div', 'thread-stances');
    stance.setAttribute('role', 'group');
    stance.setAttribute('aria-label', 'Your position on this issue');
    const agree = button('Agree', 'thread-stance', () => setStance('agree'));
    const disagree = button('Disagree', 'thread-stance', () => setStance('disagree'));
    stance.append(agree, disagree);
    stance.hidden = true;
    original.append(scopeTag, originalMeta, body, stance);
    const responses = el('section', 'thread-responses');
    const responseTitle = el('h2', '', 'Responses');
    responseTitle.id = help ? 'help-responses-heading' : 'thread-responses-heading';
    responses.setAttribute('aria-labelledby', responseTitle.id);
    const empty = el('p', 'thread-empty', 'No responses yet. Add your perspective.');
    const replies = el('ol', 'thread-replies');
    responses.append(responseTitle, empty, replies);
    responses.hidden = true;
    scroll.append(original, responses);
    const form = el('form', 'thread-reply-form');
    const draft = drafts.replies[threadId] ?? {};
    const responseField = field('Add a response', 'text', { max: 1600, multiline: true, value: draft.text ?? '' });
    const submit = el('button', 'thread-primary', 'Send response');
    submit.type = 'submit';
    const message = formMessage();
    form.append(responseField, submit, message);
    form.hidden = true;
    form.elements.text.rows = 2;
    ui = { top, network, scroll, scopeTag, originalMeta, body, stance, agree, disagree, responses, empty, replies, form, signature: '' };
    setScreen('detail', [top.section, network.bar, scroll, form], true);
    if (posted) {
      detail = { thread: posted, replies: [] };
      renderDetail();
    }
    const route = revision;
    form.addEventListener('input', () => {
      draft.text = form.elements.text.value;
      drafts.replies[threadId] = draft;
      saveDrafts();
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = form.elements.text.value.trim();
      if (!text || submit.disabled || mutations > 0 || route !== revision) return;
      draft.text = text;
      draft.pending ??= newId();
      drafts.replies[threadId] = draft;
      saveDrafts();
      submit.disabled = true;
      say(message, 'Sending…');
      mutations++;
      writeId++;
      try {
        const { reply } = await request(endpoint + '/' + threadId + '/replies', 'POST', { id: draft.pending, text });
        if (reply.text !== text) {
          delete draft.pending;
          saveDrafts();
          say(message, 'An earlier response was already sent. Your changes are still in this draft.', true);
          return;
        }
        if (form.elements.text.value.trim() === text) {
          delete drafts.replies[threadId];
          form.elements.text.value = '';
          draft.text = '';
        }
        delete draft.pending;
        saveDrafts();
        say(message, 'Response sent.');
        submit.textContent = 'Send response';
        if (active && route === revision && detail && !detail.replies.some((item) => item.id === reply.id)) {
          detail.replies = [...detail.replies, reply];
          detail.thread = { ...detail.thread, replyCount: detail.thread.replyCount + 1 };
          renderDetail();
          ui.scroll.scrollTop = ui.scroll.scrollHeight;
        }
      } catch (error) {
        if (error.status === 401) Promise.resolve().then(onAuthExpired).catch(() => {});
        say(message, error.message + ' Your response is saved here.', true);
        submit.textContent = 'Retry response';
      } finally {
        mutations--;
        writeId++;
        submit.disabled = false;
        refresh();
      }
    });
    refresh();
  }

  function renderDetail() {
    const { thread, replies } = detail;
    ui.top.heading.textContent = thread.title;
    ui.scopeTag.textContent = labelScope(thread.scope);
    ui.originalMeta.replaceChildren(avatar(thread.author), el('strong', '', thread.author), showTime(thread.createdAt));
    ui.body.textContent = thread.text;
    for (const [choice, value, total] of [
      [ui.agree, 'agree', thread.agreeCount],
      [ui.disagree, 'disagree', thread.disagreeCount],
    ]) {
      choice.textContent = (value === 'agree' ? 'Agree' : 'Disagree') + ' · ' + total;
      choice.setAttribute('aria-pressed', String(thread.stance === value));
    }
    ui.stance.hidden = help;
    ui.responses.hidden = ui.form.hidden = false;
    ui.empty.hidden = replies.length > 0;
    const signature = JSON.stringify(replies);
    if (signature !== ui.signature) {
      ui.replies.replaceChildren(...replies.map((reply) => {
        const item = el('li', 'thread-response');
        const meta = el('div', 'thread-author');
        meta.append(avatar(reply.author), el('strong', '', reply.author), showTime(reply.createdAt));
        item.append(meta, el('p', 'thread-body', reply.text));
        return item;
      }));
      ui.signature = signature;
    }
  }

  async function setStance(value) {
    if (!detail || ui.agree.disabled || mutations > 0) return;
    const route = revision;
    const threadId = selected;
    const stance = detail.thread.stance === value ? null : value;
    ui.agree.disabled = ui.disagree.disabled = true;
    mutations++;
    writeId++;
    try {
      const { thread } = await request('/threads/' + threadId + '/stance', 'PUT', { stance });
      if (active && route === revision) {
        detail.thread = thread;
        renderDetail();
      }
    } catch (error) {
      if (active && route === revision) networkError(error);
    } finally {
      mutations--;
      writeId++;
      if (active && route === revision) ui.agree.disabled = ui.disagree.disabled = false;
      refresh();
    }
  }

  async function refresh() {
    if (!active || root.hidden || screen === 'compose' || mutations > 0) return;
    const route = revision;
    const written = writeId;
    if (pendingRead?.route === route && pendingRead.written === written) return;
    const ticket = { route, written };
    pendingRead = ticket;
    try {
      const response = await request(screen === 'detail' ? endpoint + '/' + selected : endpoint);
      if (!active || route !== revision || pendingRead !== ticket || written !== writeId) return;
      ui.network.bar.hidden = true;
      if (screen === 'detail') {
        detail = response;
        renderDetail();
      } else {
        list = response.threads;
        renderList();
      }
    } catch (error) {
      if (active && route === revision && pendingRead === ticket && written === writeId) networkError(error);
    } finally {
      if (pendingRead === ticket) pendingRead = null;
    }
  }

  return {
    open() {
      root.hidden = false;
      if (active) return;
      active = true;
      listView();
    },
    close() {
      active = false;
      revision++;
      root.hidden = true;
    },
    poll: refresh,
  };
}
