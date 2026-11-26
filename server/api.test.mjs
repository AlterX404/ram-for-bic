import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleApi } from './api.mjs';
import { openDatabase } from './sqlite.mjs';

function client(getDatabase) {
  let cookie;
  return async (route, method = 'GET', data, expected = 200) => {
    const response = await handleApi(new Request('http://localhost/api' + route, {
      method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }), getDatabase());
    const setCookie = response.headers.get('Set-Cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const payload = await response.json();
    assert.equal(response.status, expected, method + ' ' + route + ' ' + (payload.error || ''));
    return payload;
  };
}

async function account(makeRequest, handle, name) {
  return (await makeRequest('/auth/register', 'POST', { handle, name, password: 'field-notes-ceramic-63' }, 201)).user;
}

test('two accounts exchange messages, sync revisions, track reads and retry idempotently', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'commonroom-test-'));
  const path = join(directory, 'data.sqlite');
  let db = openDatabase(path);
  try {
    const owner = client(() => db), member = client(() => db), outsider = client(() => db);
    const mara = await account(owner, 'mara', 'Mara');
    await account(member, 'jules', 'Jules');
    assert.deepEqual(await outsider('/health'), { ok: true });
    await outsider('/me', 'GET', undefined, 401);
    const server = await owner('/servers', 'POST', { name: 'Window Garden' }, 201);
    const serverRoute = '/servers/' + server.id;
    const messages = '/channels/' + server.channelId + '/messages';
    const invite = await owner(serverRoute + '/invites', 'POST', { hours: 24 }, 201);
    await member('/join', 'POST', { token: invite.token });
    const baseline = await member(messages);
    assert.deepEqual(baseline.messages, []);
    const request = { id: crypto.randomUUID(), text: 'The terrarium has a new leaf.' };
    const sent = (await owner(messages, 'POST', request, 201)).message;
    assert.equal(sent.authorId, mara.id);
    assert.equal((await member(serverRoute)).channels[0].unread, 1);
    assert.equal((await member('/servers')).servers[0].unread, 1);
    assert.equal((await owner(messages, 'POST', request)).message.seq, sent.seq);
    let delta = await member(messages + '?cursor=' + baseline.cursor);
    assert.deepEqual(delta.messages.map(({ id }) => id), [sent.id]);
    await member('/channels/' + server.channelId + '/read', 'POST', { seq: sent.seq });
    assert.equal((await member(serverRoute)).channels[0].unread, 0);
    assert.deepEqual((await member(messages + '?cursor=' + delta.cursor)).messages, []);
    const reply = (await member(messages, 'POST', { id: crypto.randomUUID(), text: 'I see it!', replyToId: sent.id }, 201)).message;
    assert.equal(reply.replyText, request.text);
    await member('/messages/' + sent.id, 'PATCH', { text: 'Cannot edit the owner.' }, 403);
    const reaction = '/messages/' + sent.id + '/reaction';
    await member(reaction, 'PUT', { emoji: '💡', active: true });
    await member(reaction, 'PUT', { emoji: '💡', active: true });
    assert.equal((await member(messages)).messages[0].reactions[0].count, 1);
    assert.equal((await member(reaction, 'PUT', { emoji: '💡', active: false })).message.reactions.length, 0);
    const firstEdit = (await owner('/messages/' + sent.id, 'PATCH', {
      text: 'Two leaves this morning.', editedAt: sent.editedAt,
    })).message;
    await owner('/messages/' + sent.id, 'PATCH', { text: 'Stale edit', editedAt: sent.editedAt }, 409);
    assert.ok(firstEdit.editedAt > 0);
    delta = await member(messages + '?cursor=' + delta.cursor);
    assert.equal(delta.messages.find(({ id }) => id === reply.id).replyText, 'Two leaves this morning.');
    await owner('/messages/' + sent.id, 'DELETE');
    assert.equal((await member(messages)).messages[0].text, '');
    db.sql.close();
    db = openDatabase(path);
    assert.equal((await member('/me')).user.name, 'Jules');
    assert.equal((await member(messages)).messages.at(-1).text, 'I see it!');
  } finally {
    db.sql.close();
    unlinkSync(path);
    rmdirSync(directory);
  }
});

test('server roles guard invites, visibility, moderation, ordering and the owner', async () => {
  const db = openDatabase(':memory:');
  let modBinding = db;
  const owner = client(() => db), mod = client(() => modBinding), member = client(() => db);
  const proprietor = await account(owner, 'owner', 'Owner');
  const moderator = await account(mod, 'helper', 'Helper');
  const student = await account(member, 'student', 'Student');
  const { id, channelId } = await owner('/servers', 'POST', { name: 'Old name' }, 201);
  const path = '/servers/' + id;
  await owner(path, 'PATCH', { name: 'Birdwatchers' });
  assert.equal((await owner(path)).name, 'Birdwatchers');
  const bad = await owner(path + '/invites', 'POST', { hours: 1 }, 201);
  await owner(path + '/invites/' + bad.id, 'DELETE');
  await member('/join', 'POST', { token: bad.token }, 410);
  const expired = await owner(path + '/invites', 'POST', { hours: 1 }, 201);
  db.sql.prepare('UPDATE cr_invites SET expires_at=0 WHERE id=?').run(expired.id);
  await member('/join', 'POST', { token: expired.token }, 410);
  const invite = await owner(path + '/invites', 'POST', { hours: 24 }, 201);
  await member('/join', 'POST', { token: invite.token });
  await mod('/join', 'POST', { token: invite.token });
  await owner(path + '/members/' + moderator.id, 'PATCH', { role: 'moderator' });
  const category = await owner(path + '/categories', 'POST', { name: 'Planning' }, 201);
  const privileged = await owner(path + '/channels', 'POST', {
    categoryId: category.id, name: 'Staff room', topic: 'Private planning', allowedRoles: ['moderator'],
  }, 201);
  const second = await owner(path + '/channels', 'POST', { categoryId: category.id, name: 'Weekend', allowedRoles: ['member', 'moderator'] }, 201);
  await owner('/channels/' + second.id + '/order', 'POST', { direction: 'up' });
  assert.deepEqual((await owner(path)).channels.filter((channel) => channel.categoryId === category.id).map((channel) => channel.id),
    [second.id, privileged.id]);
  await owner('/channels/' + privileged.id, 'PATCH', { name: 'Staff room', topic: 'Members excluded', allowedRoles: ['moderator'] });
  assert.equal((await mod(path)).channels.find(({ id }) => id === privileged.id).topic, 'Members excluded');
  assert.ok(!(await member(path)).channels.some(({ id }) => id === privileged.id));
  const privatePath = '/channels/' + privileged.id + '/messages';
  await mod(privatePath, 'POST', { id: crypto.randomUUID(), text: 'Private moderation keyword' }, 201);
  await member(privatePath, 'GET', undefined, 403);
  await member(privatePath + '?cursor=0', 'GET', undefined, 403);
  await member(privatePath, 'POST', { id: crypto.randomUUID(), text: 'Unauthorised' }, 403);
  assert.equal((await member(path + '/search?q=keyword')).matches.length, 0);
  assert.equal((await mod(path + '/search?q=keyword')).matches.length, 1);
  const { message } = await member('/channels/' + channelId + '/messages', 'POST', { id: crypto.randomUUID(), text: 'Public message' }, 201);
  await mod('/messages/' + message.id, 'DELETE');
  await member(path + '/audit', 'GET', undefined, 403);
  assert.ok((await mod(path + '/audit')).entries.some((entry) => entry.action === 'Removed message in #commons'));
  const { message: protectedMessage } = await member('/channels/' + channelId + '/messages', 'POST', {
    id: crypto.randomUUID(), text: 'Still visible after a failed moderation attempt',
  }, 201);
  modBinding = { ...db, batch(entries) {
    db.sql.prepare("UPDATE cr_members SET role='member' WHERE server_id=? AND user_id=?").run(id, moderator.id);
    return db.batch(entries);
  } };
  await mod('/messages/' + protectedMessage.id, 'DELETE', undefined, 403);
  assert.equal((await member('/channels/' + channelId + '/messages')).messages.at(-1).deletedAt, null);
  modBinding = db;
  await owner(path + '/members/' + moderator.id, 'PATCH', { role: 'moderator' });
  await mod(path + '/members/' + proprietor.id, 'DELETE', undefined, 409);
  await owner(path + '/leave', 'POST', undefined, 409);
  await mod(path + '/members/' + student.id, 'DELETE');
  await member('/channels/' + channelId + '/messages', 'GET', undefined, 403);
  assert.ok((await owner(path + '/audit')).entries.some((entry) => entry.action === 'Removed member'));
  await member('/join', 'POST', { token: invite.token });
  await member(path + '/leave', 'POST');
  await member(path, 'GET', undefined, 403);
  db.sql.close();
});

test('validates message data, limits bursts and paginates ordered history', async () => {
  const db = openDatabase(':memory:');
  const owner = client(() => db);
  const user = await account(owner, 'historian', 'Historian');
  const { channelId } = await owner('/servers', 'POST', { name: 'Local history' }, 201);
  const route = '/channels/' + channelId + '/messages';
  await owner(route, 'POST', { id: crypto.randomUUID(), text: ' ' }, 400);
  for (let n = 1; n <= 8; n++) await owner(route, 'POST', { id: crypto.randomUUID(), text: 'Live message ' + n }, 201);
  await owner(route, 'POST', { id: crypto.randomUUID(), text: 'Too many messages' }, 429);
  const statement = db.sql.prepare('INSERT INTO cr_messages(id,channel_id,author_id,text,created_at) VALUES(?,?,?,?,?)');
  for (let n = 9; n <= 44; n++) statement.run(crypto.randomUUID(), channelId, user.id, 'Fixture message ' + n, Date.now());
  const latest = await owner(route);
  const older = await owner(route + '?before=' + latest.messages[0].seq);
  assert.equal(latest.messages.length, 40);
  assert.equal(older.messages.length, 4);
  assert.equal(latest.hasOlder, true);
  assert.equal(older.hasOlder, false);
  assert.ok(older.messages.at(-1).seq < latest.messages[0].seq);
  db.sql.close();
});

test('guest browsers share fixed rooms without passwords and reuse their own session', async () => {
  const db = openDatabase(':memory:');
  const first = client(() => db), second = client(() => db), anonymous = client(() => db);
  try {
    assert.deepEqual(await anonymous('/health'), { ok: true });
    await anonymous('/threads', 'GET', undefined, 401);
    const firstEntry = await first('/auth/guest', 'POST', {}, 201);
    assert.match(firstEntry.user.name, /^Guest [0-9A-F]{6}$/);
    assert.deepEqual(await first('/auth/guest', 'POST', {}), firstEntry);
    const secondEntry = await second('/auth/guest', 'POST', {}, 201);
    assert.notEqual(firstEntry.user.id, secondEntry.user.id);
    assert.deepEqual(firstEntry.spaces, secondEntry.spaces);
    assert.deepEqual((await first('/servers')).servers.map(({ name, role }) => [name, role]),
      [['BIC Campus', 'member'], ['Class Rooms', 'member']]);
    const { global, classA, classB, campus, announcements } = firstEntry.spaces;
    assert.equal((await first('/servers/' + campus)).channels.find(({ id }) => id === announcements).readOnly, true);
    await first('/channels/' + announcements + '/messages', 'POST', { id: crypto.randomUUID(), text: 'Unauthorised announcement' }, 403);
    const payload = { id: crypto.randomUUID(), text: 'Campus welcomes everyone.' };
    await first('/channels/' + global + '/messages', 'POST', payload, 201);
    await first('/channels/' + classA + '/messages', 'POST', { id: crypto.randomUUID(), text: 'Class A has a study group.' }, 201);
    assert.equal((await second('/channels/' + global + '/messages')).messages[0].text, payload.text);
    assert.equal((await second('/channels/' + classA + '/messages')).messages[0].text, 'Class A has a study group.');
    assert.deepEqual((await second('/channels/' + classB + '/messages')).messages, []);
  } finally {
    db.sql.close();
  }
});

test('guests post and respond to scoped issues and independently change stance', async () => {
  const db = openDatabase(':memory:');
  const first = client(() => db), second = client(() => db);
  try {
    const firstEntry = await first('/auth/guest', 'POST', {}, 201);
    const secondEntry = await second('/auth/guest', 'POST', {}, 201);
    const id = crypto.randomUUID();
    const payload = { id, title: 'A shared whiteboard', text: 'Could Class A get a shared whiteboard?', scope: 'class-a' };
    await first('/threads', 'POST', { ...payload, scope: 'invalid' }, 400);
    const created = await first('/threads', 'POST', payload, 201);
    assert.deepEqual(await first('/threads', 'POST', payload), created);
    await second('/threads', 'POST', payload, 409);
    assert.equal(created.thread.author, firstEntry.user.name);
    assert.equal(created.thread.replyCount, 0);
    const path = '/threads/' + id;
    const reply = { id: crypto.randomUUID(), text: 'We could try a rotating setup.' };
    const response = await second(path + '/replies', 'POST', reply, 201);
    assert.deepEqual(await second(path + '/replies', 'POST', reply), response);
    assert.equal(response.reply.author, secondEntry.user.name);
    const agreed = (await second(path + '/stance', 'PUT', { stance: 'agree' })).thread;
    assert.deepEqual([agreed.agreeCount, agreed.disagreeCount, agreed.stance], [1, 0, 'agree']);
    const firstVote = (await first(path + '/stance', 'PUT', { stance: 'disagree' })).thread;
    assert.deepEqual([firstVote.agreeCount, firstVote.disagreeCount, firstVote.stance], [1, 1, 'disagree']);
    const switched = (await second(path + '/stance', 'PUT', { stance: 'disagree' })).thread;
    assert.deepEqual([switched.agreeCount, switched.disagreeCount, switched.stance], [0, 2, 'disagree']);
    const cleared = (await second(path + '/stance', 'PUT', { stance: null })).thread;
    assert.deepEqual([cleared.agreeCount, cleared.disagreeCount, cleared.stance], [0, 1, null]);
    const detail = await first(path);
    assert.equal(detail.thread.replyCount, 1);
    assert.deepEqual(detail.replies, [response.reply]);
    assert.equal((await second('/threads')).threads[0].scope, 'class-a');
    await second('/servers/' + secondEntry.spaces.classes + '/leave', 'POST');
    assert.deepEqual((await second('/threads')).threads, []);
    await second(path, 'GET', undefined, 404);
    await second(path + '/stance', 'PUT', { stance: 'agree' }, 404);
  } finally {
    db.sql.close();
  }
});
test('help questions and their responses stay separate from issues', async () => {
  const db = openDatabase(':memory:');
  try {
    const ask = client(() => db), answer = client(() => db), visitor = client(() => db);
    await visitor('/help', 'GET', undefined, 401);
    await ask('/auth/guest', 'POST', {}, 201);
    await answer('/auth/guest', 'POST', {}, 201);
    const question = { id: crypto.randomUUID(), title: 'Where is the welcome checklist?', text: 'I am preparing for my first week.', scope: 'campus' };
    const issue = { ...question, id: crypto.randomUUID(), title: 'Simplify classroom notices' };
    await ask('/help', 'POST', question, 201);
    await ask('/help', 'POST', question, 200);
    await ask('/threads', 'POST', issue, 201);
    assert.deepEqual((await answer('/help')).threads.map(({ id }) => id), [question.id]);
    assert.deepEqual((await answer('/threads')).threads.map(({ id }) => id), [issue.id]);
    await answer('/threads/' + question.id, 'GET', undefined, 404);
    await answer('/help/' + issue.id, 'GET', undefined, 404);
    await answer('/help/' + question.id + '/stance', 'PUT', { stance: 'agree' }, 404);
    const response = { id: crypto.randomUUID(), text: 'Start with the welcome email.' };
    await answer('/help/' + question.id + '/replies', 'POST', response, 201);
    await answer('/help/' + question.id + '/replies', 'POST', response, 200);
    const result = await ask('/help/' + question.id);
    assert.equal(result.thread.replyCount, 1);
    assert.equal(result.replies[0].text, response.text);
  } finally { db.sql.close(); }
});
