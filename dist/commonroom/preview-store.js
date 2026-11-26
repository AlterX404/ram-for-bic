const previewRequest = (() => {
  const storageKey = 'ram-for-bic-commonroom-preview-v2';
  const previousKey = 'ram-for-bic-static-commonroom-v1';
  const user = { id: 'preview-guest', name: 'You', isGuest: true };
  const rooms = {
    global: { name: 'global', topic: 'Talk across classes.', server: 'campus' },
    announcements: { name: 'announcements', topic: 'Sample student program and activity updates.', server: 'campus', readOnly: true },
    'class-a': { name: 'class-a', topic: 'Coordinate with Class A.', server: 'classes' },
    'class-b': { name: 'class-b', topic: 'Coordinate with Class B.', server: 'classes' },
  };
  const spaces = { campus: 'campus', classes: 'classes', global: 'global', classA: 'class-a', classB: 'class-b' };
  const names = { campus: 'BIC Campus', classes: 'Class rooms' };
  const date = Date.parse('2026-11-26T10:00:00+01:00');
  const example = (id, author, text, extra) => ({ id, author, text, createdAt: date, ...extra });
  const visitorPost = (id, text) => ({ id, author: user.name, authorId: user.id, text, createdAt: Date.now() });
  const sample = {
    global: [
      example('sample-meet', 'Maya', 'Does anyone want to meet at the entrance before the welcome session?'),
      example('sample-join', 'Leon', 'I can join. We could compare what we need for the first week.'),
    ],
    announcements: [
      example('sample-announcement', 'Campus team', 'Sample update. A peer study group will meet in the student lounge this week.'),
    ],
    'class-a': [example('sample-class-a', 'Maya', 'I’m putting together a study group. Which afternoons work for you?')],
    'class-b': [example('sample-class-b', 'Leon', 'I made a list of topics to review. Does anyone want to go through it after class?')],
  };
  const sampleBoards = {
    threads: [example('sample-issue', 'Maya', 'Could BIC post timetable changes in one place?', {
      title: 'Make timetable changes easier to find', scope: 'campus',
      replies: [example('sample-issue-reply', 'Leon', 'A notice with the new room and time would help.')],
    })],
    help: [example('sample-help', 'Sam', 'I’m getting ready for my first week. Where should I look for arrival details?', {
      title: 'What should I check before my first day?', scope: 'campus',
      replies: [example('sample-help-reply', 'Maya', 'Start with your welcome information in Classter.')],
    })],
  };
  const members = [user, { id: 'preview-maya', name: 'Maya' }, { id: 'preview-leon', name: 'Leon' }];
  let memory;
  let canPersist = true;

  function saved(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }

  function initialize() {
    const previous = saved(previousKey);
    const messages = Object.fromEntries(Object.entries(sample).map(([channel, rows]) => {
      const legacy = Array.isArray(previous?.[channel === 'global' ? 'campus' : channel])
        ? previous[channel === 'global' ? 'campus' : channel] : [];
      const personal = legacy.filter((row) => row.author === 'You').map((row, index) =>
        visitorPost('previous-' + channel + '-' + index, row.text));
      return [channel, [...rows, ...personal].map((row, index) => ({
        ...row, seq: index + 1, revision: 0, reactions: [],
        ...(row.id.startsWith('sample-') ? { authorId: 'example-' + row.author.toLowerCase() } : {}),
      }))];
    }));
    const boards = structuredClone(sampleBoards);
    for (const kind of ['threads', 'help']) {
      const old = previous?.[kind === 'threads' ? 'issues' : kind];
      if (!Array.isArray(old)) continue;
      for (const row of old) {
        const entry = boards[kind].find((topic) => topic.id === row.id);
        const replies = Array.isArray(row.replies) ? row.replies
          .filter((reply) => reply.author === 'You')
          .map((reply, index) => visitorPost('previous-' + row.id + '-' + index, reply.text)) : [];
        const stance = row.stance === 'Agree' ? 'agree' : row.stance === 'Disagree' ? 'disagree' : null;
        if (entry) {
          entry.replies.push(...replies);
          entry.stance = stance;
        } else if (row.author === 'You' && typeof row.id === 'string') {
          boards[kind].push({ ...visitorPost(row.id, row.text), title: row.title, scope: 'campus', replies, stance });
        }
      }
    }
    return { messages, boards, reads: {}, revision: 0 };
  }

  function database() {
    return (canPersist ? saved(storageKey) : null) ?? (memory ??= initialize());
  }

  function save(db) {
    memory = db;
    try {
      localStorage.setItem(storageKey, JSON.stringify(db));
    } catch {
      canPersist = false;
      document.dispatchEvent(new Event('commonroom-preview-temporary'));
    }
  }

  function fail(message, status = 400) {
    throw Object.assign(new Error(message), { status });
  }

  function content(value, label, max, min = 1) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length < min || text.length > max) fail(label + ' must have ' + min + '–' + max + ' characters.');
    return text;
  }

  function revise(db, row) {
    row.revision = ++db.revision;
    save(db);
  }

  function feed(db, rows, params) {
    if (params.has('cursor')) {
      const cursor = Number(params.get('cursor'));
      return { messages: rows.filter((row) => row.revision > cursor), cursor: db.revision, more: false };
    }
    const before = Number(params.get('before') ?? Infinity);
    const history = rows.filter((row) => row.seq < before);
    return { messages: history.slice(-40), cursor: db.revision, hasOlder: history.length > 40 };
  }

  function server(db, id) {
    const channels = Object.entries(rooms).filter(([, room]) => room.server === id).map(([channel, room]) => ({
      id: channel, ...room,
      unread: db.messages[channel].filter((row) => row.seq > (db.reads[channel] ?? 0) && row.authorId !== user.id).length,
    }));
    return { id, name: names[id], role: 'member', channels, members };
  }

  function readMessage(db, id) {
    const row = Object.values(db.messages).flat().find((message) => message.id === id && !message.deletedAt);
    if (!row) fail('This message is unavailable.', 404);
    return row;
  }

  function threadSummary({ replies, ...thread }) {
    return { ...thread, replyCount: replies.length,
      agreeCount: Number(thread.stance === 'agree'), disagreeCount: Number(thread.stance === 'disagree') };
  }

  function boardAction(db, area, id, resource, method, input) {
    const board = db.boards[area];
    if (!id && method === 'GET') return { threads: board.map(threadSummary).reverse() };
    if (!id && method === 'POST') {
      let thread = board.find((item) => item.id === input.id);
      if (!thread) {
        if (!['campus', 'class-a', 'class-b'].includes(input.scope)) fail('Choose a discussion space.');
        thread = { ...visitorPost(input.id, content(input.text, 'Details', 2400, 3)),
          title: content(input.title, 'Title', 100, 3), scope: input.scope, replies: [], stance: null };
        board.push(thread);
        save(db);
      }
      return { thread: threadSummary(thread) };
    }
    const thread = board.find((item) => item.id === id);
    if (!thread) fail('This discussion is unavailable.', 404);
    if (!resource && method === 'GET') return { thread: threadSummary(thread), replies: thread.replies };
    if (resource === 'replies' && method === 'POST') {
      let reply = thread.replies.find((item) => item.id === input.id);
      if (!reply) {
        reply = visitorPost(input.id, content(input.text, 'Response', 1600));
        thread.replies.push(reply);
        save(db);
      }
      return { reply };
    }
    if (area === 'threads' && resource === 'stance' && method === 'PUT') {
      if (![null, 'agree', 'disagree'].includes(input.stance)) fail('Choose a position.');
      thread.stance = input.stance;
      save(db);
      return { thread: threadSummary(thread) };
    }
    fail('This discussion action is unavailable.', 404);
  }

  return async (path, method = 'GET', input = {}) => {
    const url = new URL(path, 'https://preview.invalid');
    const [area, id, resource] = url.pathname.slice(1).split('/');
    const db = database();
    if (area === 'auth' && id === 'guest') return { user, spaces };
    if (area === 'threads' || area === 'help') return boardAction(db, area, id, resource, method, input);
    if (area === 'servers' && Object.hasOwn(names, id)) {
      if (resource !== 'search') return server(db, id);
      const q = content(url.searchParams.get('q'), 'Search', 80).toLowerCase();
      const matches = server(db, id).channels.flatMap((channel) => db.messages[channel.id]
        .filter((message) => !message.deletedAt && message.text.toLowerCase().includes(q))
        .map((message) => ({ ...message, channelId: channel.id, channel: channel.name })));
      return { matches: matches.slice(0, 50) };
    }
    if (area === 'channels' && Object.hasOwn(rooms, id)) {
      const rows = db.messages[id];
      if (resource === 'read' && method === 'POST') {
        if (input.seq > (db.reads[id] ?? 0)) { db.reads[id] = input.seq; save(db); }
        return { ok: true };
      }
      if (resource === 'messages' && method === 'GET') return feed(db, rows, url.searchParams);
      if (resource === 'messages' && method === 'POST' && !rooms[id].readOnly) {
        const previous = rows.find((row) => row.id === input.id);
        if (previous) return { message: previous };
        const message = { ...visitorPost(input.id, content(input.text, 'Message', 2000)),
          seq: (rows.at(-1)?.seq ?? 0) + 1, reactions: [] };
        if (input.replyToId) {
          const quoted = rows.find((row) => row.id === input.replyToId && !row.deletedAt);
          if (!quoted) fail('Choose a reply from this channel.');
          Object.assign(message, { replyToId: quoted.id, replyText: quoted.text.slice(0, 140), replyAuthor: quoted.author });
        }
        rows.push(message);
        revise(db, message);
        return { message };
      }
    }
    if (area === 'messages') {
      const message = readMessage(db, id);
      if (resource === 'reaction' && method === 'PUT') {
        message.reactions = message.reactions.filter((entry) => entry.emoji !== input.emoji);
        if (input.active) message.reactions.push({ emoji: input.emoji, count: 1, mine: true });
      } else if (message.authorId !== user.id) {
        fail('You can only change your own messages.', 403);
      } else if (method === 'PATCH') {
        if ((message.editedAt ?? null) !== input.editedAt) fail('This message changed. Reopen it to edit.', 409);
        message.text = content(input.text, 'Message', 2000);
        message.editedAt = Date.now();
      } else if (method === 'DELETE') {
        Object.assign(message, { text: '', deletedAt: Date.now(), reactions: [] });
      } else {
        fail('This message action is unavailable.', 404);
      }
      revise(db, message);
      return { message };
    }
    fail('This action is unavailable in the preview.', 404);
  };
})();
