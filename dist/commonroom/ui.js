export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
export const reactionEmoji = ['👍', '❤️', '🎉', '👀', '💡'];
const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export function el(tag, className, content) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (content !== undefined) item.textContent = content;
  return item;
}

export function action(label, name, id, className = 'secondary') {
  const item = el('button', className, label);
  item.type = 'button';
  item.dataset.action = name;
  if (id) item.dataset.id = id;
  return item;
}

export function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((word) => Array.from(word)[0]).join('').toUpperCase();
}

export function avatar(name) {
  const tone = ['avatar-gold', 'avatar-indigo', 'avatar-green'][name.charCodeAt(0) % 3] || 'avatar-indigo';
  const node = el('span', 'avatar ' + tone, initials(name));
  node.setAttribute('aria-hidden', 'true');
  return node;
}

export function readableTime(millis) {
  const date = new Date(millis);
  return day.format(date) + ', ' + time.format(date);
}

export function card(message, user, role, queued = null) {
  const item = el('li', 'message');
  item.dataset.message = message.id;
  item.tabIndex = -1;
  const body = el('div');
  const meta = el('div', 'message-meta');
  const clock = el('time', '', time.format(new Date(message.createdAt)));
  clock.dateTime = new Date(message.createdAt).toISOString();
  clock.title = readableTime(message.createdAt);
  meta.append(el('strong', '', message.author), clock);
  if (message.editedAt) meta.append(el('span', '', 'Edited'));
  body.append(meta);
  if (message.deletedAt) {
    body.append(el('p', 'removed', 'Message removed'));
  } else {
    if (message.replyToId) body.append(el('blockquote', 'reply-quote', message.replyAuthor
      ? message.replyAuthor + ' · ' + (message.replyText || 'Message removed')
      : 'Reply to a message'));
    body.append(el('p', 'message-text', message.text));
    const tools = el('div', 'message-actions');
    if (queued) {
      tools.append(el('span', 'pending', queued.sending ? 'Sending…' : queued.error || 'Waiting to send'));
      if (!queued.sending) tools.append(action('Retry', 'retry-message', message.id), action('Discard', 'discard-message', message.id));
    } else {
      const mine = message.authorId === user.id;
      tools.append(action('Reply', 'reply', message.id), action('React', 'react', message.id));
      if (mine) tools.append(action('Edit', 'edit-message', message.id));
      if (mine || role !== 'member') tools.append(action(mine ? 'Delete' : 'Remove', 'delete-message', message.id));
      const reactions = el('div', 'reaction-row');
      for (const reaction of message.reactions || []) {
        const choice = action(reaction.emoji + ' ' + reaction.count, 'toggle-reaction', message.id);
        choice.dataset.emoji = reaction.emoji;
        choice.setAttribute('aria-pressed', String(Boolean(reaction.mine)));
        choice.setAttribute('aria-label', reaction.emoji + ', ' + reaction.count + ' reactions');
        reactions.append(choice);
      }
      if (reactions.childElementCount) body.append(reactions);
    }
    body.append(tools);
  }
  item.append(avatar(message.author), body);
  return item;
}

export function field(label, name, options = {}) {
  const container = el('label', '', label);
  const control = el(options.choices ? 'select' : options.multiline ? 'textarea' : 'input');
  control.name = name;
  control.required = options.required !== false;
  if (options.choices) {
    for (const [value, caption] of options.choices) control.add(new Option(caption, value));
  } else {
    if (options.max) control.maxLength = options.max;
    if (options.multiline) control.rows = 4;
  }
  control.value = options.value ?? control.value;
  container.append(control);
  return container;
}
