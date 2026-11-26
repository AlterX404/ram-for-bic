(() => {
  const spaces = {
    campus: { title: 'Campus chat', summary: 'Talk across classes.', posts: [
      { author: 'Sample · Class A', text: 'Does anyone want to meet at the entrance before the next welcome session?' },
      { author: 'Sample · Class B', text: 'I can join. It would be useful to compare what we need for the first week.' },
    ] },
    'class-a': { title: 'Class A chat', summary: 'Discuss lessons and coordinate with your class.', posts: [
      { author: 'Sample · Class A', text: 'I’m putting together a study group. Which afternoons work for people?' },
    ] },
    'class-b': { title: 'Class B chat', summary: 'Discuss lessons and coordinate with your class.', posts: [
      { author: 'Sample · Class B', text: 'I have a list of topics to review. Does anyone want to go through it after class?' },
    ] },
    issues: { title: 'Issues', summary: 'Propose a change and see where students agree or disagree.', posts: [
      { id: 'sample-issue', title: 'Make timetable changes easier to find', author: 'Sample · Class A',
        text: 'Could BIC post changes in one place? It takes time to check several channels.',
        replies: [{ author: 'Sample · Class B', text: 'A notification with the new room and time would help.' }] },
    ] },
    help: { title: 'Help', summary: 'Ask a question or share practical advice.', posts: [
      { id: 'sample-help', title: 'What should I check before my first day?', author: 'Sample · New student',
        text: 'I’m getting ready for my first week at BIC. Where should I look for arrival details?',
        replies: [{ author: 'Sample · Current student', text: 'Start with the welcome information in Classter and check for any last-minute updates.' }] },
    ] },
  };
  const key = 'ram-for-bic-static-commonroom-v1';
  const get = (id) => document.getElementById(id);
  const heading = get('space-heading');
  const summary = get('space-summary');
  const entries = get('entries');
  const form = get('composer');
  const title = get('title');
  const message = get('message');
  const status = get('status');
  const nav = [...document.querySelectorAll('[data-space]')];
  const drafts = new Map();
  let data;
  let active = 'campus';
  let openTopic = null;

  function sampleData() {
    return Object.fromEntries(Object.entries(spaces).map(([name, space]) => [name, space.posts]));
  }

  try {
    const saved = JSON.parse(localStorage.getItem(key));
    data = saved && Object.keys(spaces).every((name) => Array.isArray(saved[name])) ? saved : sampleData();
  } catch {
    data = sampleData();
  }

  const embedded = new URLSearchParams(location.search).has('embedded');
  if (embedded) document.querySelector('.masthead a').hidden = true;

  function node(tag, text, className) {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function persist(success) {
    try {
      localStorage.setItem(key, JSON.stringify(data));
      status.textContent = success;
    } catch {
      status.textContent = 'Browser storage is unavailable. This change lasts until you close or reload the page.';
    }
  }

  function appendPost(post) {
    const row = node('li', '');
    row.append(node('strong', post.author), node('p', post.text));
    entries.append(row);
    return row;
  }

  const board = () => active === 'issues' || active === 'help';
  const draftKey = () => openTopic || active;

  function navigate(space, topic = null) {
    drafts.set(draftKey(), { title: title.value, text: message.value });
    active = space;
    openTopic = topic;
    const draft = drafts.get(draftKey());
    title.value = draft?.title ?? '';
    message.value = draft?.text ?? '';
    status.textContent = '';
    render();
    heading.focus();
  }

  function render() {
    const space = spaces[active];
    const topic = openTopic && data[active].find((post) => post.id === openTopic);
    heading.textContent = topic ? topic.title : space.title;
    summary.textContent = topic ? 'Add a response below.' : space.summary;
    get('back').hidden = !topic;
    for (const button of nav) {
      if (button.dataset.space === active) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    }
    const newTopic = board() && !topic;
    title.hidden = get('title-label').hidden = !newTopic;
    title.required = newTopic;
    get('title-label').textContent = active === 'help' ? 'Question title' : 'Issue title';
    get('message-label').textContent = topic ? 'Response' : newTopic ? 'Details' : 'Message';
    get('send').textContent = topic ? 'Send response' : newTopic
      ? (active === 'help' ? 'Post question' : 'Post issue') : 'Send message';

    entries.replaceChildren();
    if (topic) {
      const original = appendPost(topic);
      if (active === 'issues') {
        const stances = node('div', '', 'stances');
        for (const stance of ['Agree', 'Disagree']) {
          const button = node('button', stance);
          button.type = 'button';
          button.setAttribute('aria-pressed', String(topic.stance === stance));
          button.addEventListener('click', () => {
            topic.stance = topic.stance === stance ? '' : stance;
            for (const choice of stances.children) {
              choice.setAttribute('aria-pressed', String(topic.stance === choice.textContent));
            }
            persist('Your selection is saved in this browser.');
          });
          stances.append(button);
        }
        original.append(stances);
      }
      for (const reply of topic.replies) appendPost(reply);
      return;
    }

    for (const post of data[active]) {
      if (!newTopic) {
        appendPost(post);
        continue;
      }
      const row = node('li', '');
      const button = node('button', post.title, 'topic');
      button.type = 'button';
      button.addEventListener('click', () => navigate(active, post.id));
      const count = post.replies.length;
      row.append(button, node('p', post.author + ' · ' + count + (count === 1 ? ' response' : ' responses'), 'entry-meta'));
      entries.append(row);
    }
  }

  for (const button of nav) button.addEventListener('click', () => navigate(button.dataset.space));
  get('back').addEventListener('click', () => navigate(active));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = message.value.trim();
    const subject = title.value.trim();
    const newTopic = board() && !openTopic;
    if (!text || (newTopic && !subject)) {
      status.textContent = 'Enter text in each required field.';
      return;
    }
    const post = { author: 'You', text };
    if (newTopic) {
      post.id = globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2);
      post.title = subject;
      post.replies = [];
      data[active].push(post);
      drafts.delete(active);
      openTopic = post.id;
    } else if (openTopic) {
      data[active].find((entry) => entry.id === openTopic).replies.push(post);
    } else {
      data[active].push(post);
    }
    form.reset();
    render();
    persist('Saved in this browser.');
    if (newTopic) heading.focus();
    else message.focus();
  });

  render();
})();
