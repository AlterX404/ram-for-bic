import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const adapter = readFileSync(new URL('../dist/commonroom/preview-store.js', import.meta.url), 'utf8');

test('restored preview migrates browser posts and stores scoped replies and message changes across reloads', async () => {
  const storage = new Map([['ram-for-bic-static-commonroom-v1', JSON.stringify({
    campus: [{ author: 'You', text: 'Previous message' }],
    help: [{
      id: 'old-help', author: 'You', title: 'Previous question', text: 'Question details',
      replies: [{ author: 'You', text: 'Previous reply' }],
    }],
  })]]);
  const localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const open = () => runInNewContext(adapter + '\npreviewRequest', { URL, structuredClone, localStorage });
  let request = open();
  const { user, spaces } = await request('/auth/guest', 'POST');
  const initial = await request('/channels/' + spaces.global + '/messages');
  assert.equal(initial.messages.at(-1).text, 'Previous message');
  assert.equal(initial.messages.at(-1).authorId, user.id);
  assert.equal((await request('/help/old-help')).replies[0].text, 'Previous reply');
  await assert.rejects(request('/threads/old-help'), /unavailable/);

  const message = { id: 'test-message', text: 'Draft one' };
  await request('/channels/global/messages', 'POST', message);
  await request('/channels/global/messages', 'POST', message);
  await request('/messages/test-message', 'PATCH', { text: 'Updated draft', editedAt: null });
  await request('/messages/test-message/reaction', 'PUT', { emoji: '👍', active: true });
  const updates = await request('/channels/global/messages?cursor=' + initial.cursor);
  assert.equal(updates.messages.length, 1);
  assert.equal(updates.messages[0].text, 'Updated draft');
  assert.equal(updates.messages[0].reactions[0].mine, true);

  await request('/threads/sample-issue/stance', 'PUT', { stance: 'agree' });
  await request('/help/old-help/replies', 'POST', { id: 'test-reply', text: 'New response' });
  request = open();
  assert.equal((await request('/threads/sample-issue')).thread.agreeCount, 1);
  assert.equal((await request('/help/old-help')).replies.length, 2);
  assert.equal((await request('/servers/campus/search?q=updated')).matches[0].id, 'test-message');
  await request('/messages/test-message', 'DELETE');
  assert.equal((await request('/servers/campus/search?q=updated')).matches.length, 0);
});
