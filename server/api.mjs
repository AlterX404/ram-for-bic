import { database } from './store.mjs';

const roleBits = { member: 1, moderator: 2, owner: 4 };
const emojis = ['👍', '❤️', '🎉', '👀', '💡'];
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const sessionLifetime = 7 * 24 * 60 * 60;
const guestLifetime = 30 * 24 * 60 * 60;
const encoder = new TextEncoder();

const campusOwner = '7905c7ae-9b42-4d04-924a-496b15bc6800';
const campusSpaces = Object.freeze({
  campus: '7905c7ae-9b42-4d04-924a-496b15bc6801',
  classes: '7905c7ae-9b42-4d04-924a-496b15bc6802',
  global: '7905c7ae-9b42-4d04-924a-496b15bc6811',
  classA: '7905c7ae-9b42-4d04-924a-496b15bc6812',
  classB: '7905c7ae-9b42-4d04-924a-496b15bc6813',
  announcements: '7905c7ae-9b42-4d04-924a-496b15bc6814',
});
const campusCategory = '7905c7ae-9b42-4d04-924a-496b15bc6821';
const classesCategory = '7905c7ae-9b42-4d04-924a-496b15bc6822';
const threadScopes = Object.freeze({ campus: campusSpaces.global, 'class-a': campusSpaces.classA, 'class-b': campusSpaces.classB });

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function reject(status, message) {
  throw new ApiError(status, message);
}

function json(payload, status = 200, extra = {}) {
  return new Response(JSON.stringify(payload), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

async function body(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) reject(415, 'Send JSON data.');
  const reader = request.body?.getReader();
  if (!reader) reject(400, 'Request data is missing.');
  const decoder = new TextDecoder();
  let bytes = 0;
  let source = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 16_384) {
      await reader.cancel();
      reject(413, 'Request is too large.');
    }
    source += decoder.decode(value, { stream: true });
  }
  try {
    const result = JSON.parse(source + decoder.decode());
    if (result && typeof result === 'object' && !Array.isArray(result)) return result;
  } catch {
    // Invalid JSON is a client error.
  }
  reject(400, 'Send a valid JSON object.');
}

function text(value, label, min, max) {
  if (typeof value !== 'string') reject(400, label + ' is required.');
  const result = value.trim();
  if (result.length < min || result.length > max) reject(400, label + ' must have ' + min + '–' + max + ' characters.');
  return result;
}

function number(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) reject(400, label + ' is invalid.');
  return value;
}

const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const token = (size = 32) => hex(crypto.getRandomValues(new Uint8Array(size)));
const now = () => Date.now();
const id = () => crypto.randomUUID();

async function digest(value) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({
    name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations: 100_000,
  }, key, 256)));
}

function equalHash(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cookie(request, value, age) {
  return 'commonroom_session=' + value + '; Path=/api; HttpOnly; SameSite=Lax; Max-Age=' + age
    + (new URL(request.url).protocol === 'https:' ? '; Secure' : '');
}

function sessionToken(request) {
  return request.headers.get('Cookie')?.match(/(?:^|;\s*)commonroom_session=([a-f0-9]{64})(?:;|$)/)?.[1];
}

async function rate(db, bucket, limit, duration) {
  const time = now();
  const entry = await db.one(`INSERT INTO cr_rate(bucket,start_at,hits) VALUES(?,?,1)
    ON CONFLICT(bucket) DO UPDATE SET
      hits=CASE WHEN cr_rate.start_at<=? THEN 1 ELSE cr_rate.hits+1 END,
      start_at=CASE WHEN cr_rate.start_at<=? THEN excluded.start_at ELSE cr_rate.start_at END
    RETURNING hits`, bucket, time, time - duration, time - duration);
  if (entry.hits > limit) reject(429, 'Too many attempts. Wait a minute and try again.');
}

async function login(db, request, register) {
  const input = await body(request);
  const handle = text(input.handle, 'Username', 3, 24).toLowerCase();
  if (!/^[a-z0-9_]+$/.test(handle)) reject(400, 'Use letters, digits or underscores in your username.');
  if (typeof input.password !== 'string' || input.password.length < 10 || input.password.length > 128) {
    reject(400, 'Use a password between 10 and 128 characters.');
  }
  const address = request.headers.get('CF-Connecting-IP') || 'local';
  await rate(db, 'auth:' + await digest(address), 45, 60_000);
  await rate(db, 'handle:' + handle, 12, 60_000);
  let user;
  if (register) {
    const name = text(input.name, 'Display name', 2, 40);
    const salt = token(16);
    const hash = await passwordHash(input.password, salt);
    user = await db.one(`INSERT INTO cr_users(id,handle,name,salt,password_hash) VALUES(?,?,?,?,?)
      ON CONFLICT(handle) DO NOTHING RETURNING id,handle,name`, id(), handle, name, salt, hash);
    if (!user) reject(409, 'That username is already taken.');
  } else {
    const row = await db.one('SELECT * FROM cr_users WHERE handle=?', handle);
    const hash = await passwordHash(input.password, row?.salt || 'invalid-account-salt');
    if (!equalHash(hash, row?.password_hash || '0'.repeat(64)) || !row) reject(401, 'Username or password is incorrect.');
    user = { id: row.id, handle: row.handle, name: row.name };
  }
  const raw = token();
  await db.run('INSERT INTO cr_sessions VALUES(?,?,?)', await digest(raw), user.id, now() + sessionLifetime * 1000);
  return json({ user }, register ? 201 : 200, { 'Set-Cookie': cookie(request, raw, sessionLifetime) });
}

async function findSession(db, request) {
  const raw = sessionToken(request);
  return raw && await db.one(`SELECT u.id,u.handle,u.name FROM cr_sessions s JOIN cr_users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>?`, await digest(raw), now());
}

async function authenticate(db, request) {
  const user = await findSession(db, request);
  if (!user) reject(401, 'Sign in to use Commonroom.');
  return user;
}

function campusSetup(db, user) {
  return [
    db.statement(`INSERT OR IGNORE INTO cr_users(id,handle,name,salt,password_hash) VALUES(?,?,?,?,?)`,
      campusOwner, ':commonroom-campus', 'Commonroom', '', 'disabled'),
    db.statement('INSERT OR IGNORE INTO cr_servers VALUES(?,?,?,0)', campusSpaces.campus, 'BIC Campus', campusOwner),
    db.statement('INSERT OR IGNORE INTO cr_servers VALUES(?,?,?,0)', campusSpaces.classes, 'Class Rooms', campusOwner),
    db.statement("INSERT OR IGNORE INTO cr_members VALUES(?,?,'owner')", campusSpaces.campus, campusOwner),
    db.statement("INSERT OR IGNORE INTO cr_members VALUES(?,?,'owner')", campusSpaces.classes, campusOwner),
    db.statement('INSERT OR IGNORE INTO cr_categories VALUES(?,?,?,1)', campusCategory, campusSpaces.campus, 'Campus'),
    db.statement('INSERT OR IGNORE INTO cr_categories VALUES(?,?,?,1)', classesCategory, campusSpaces.classes, 'Classes'),
    db.statement('INSERT OR IGNORE INTO cr_channels VALUES(?,?,?,?,?,7,1)', campusSpaces.global, campusSpaces.campus,
      campusCategory, 'global-chat', 'Open conversation for everyone at BIC.'),
    db.statement('INSERT OR IGNORE INTO cr_channels VALUES(?,?,?,?,?,7,2)', campusSpaces.announcements, campusSpaces.campus,
      campusCategory, 'announcements', 'Read-only updates from the workspace team.'),
    db.statement('INSERT OR IGNORE INTO cr_channels VALUES(?,?,?,?,?,7,1)', campusSpaces.classA, campusSpaces.classes,
      classesCategory, 'class-a', 'Class A conversations, study notes and questions.'),
    db.statement('INSERT OR IGNORE INTO cr_channels VALUES(?,?,?,?,?,7,2)', campusSpaces.classB, campusSpaces.classes,
      classesCategory, 'class-b', 'Class B conversations, study notes and questions.'),
    db.statement("INSERT OR IGNORE INTO cr_members VALUES(?,?,'member')", campusSpaces.campus, user.id),
    db.statement("INSERT OR IGNORE INTO cr_members VALUES(?,?,'member')", campusSpaces.classes, user.id),
  ];
}

async function guest(db, request) {
  await body(request);
  const existing = await findSession(db, request);
  if (existing) {
    const ready = await db.one(`SELECT count(*) AS total FROM cr_members
      WHERE user_id=? AND server_id IN (?,?)`, existing.id, campusSpaces.campus, campusSpaces.classes);
    if (ready.total !== 2) await db.batch(campusSetup(db, existing));
    return json({ user: existing, spaces: campusSpaces });
  }

  const address = request.headers.get('CF-Connecting-IP') || 'local';
  await rate(db, 'guest:' + await digest(address), 45, 60_000);
  const suffix = token(8);
  const user = { id: id(), handle: 'guest_' + suffix, name: 'Guest ' + suffix.slice(0, 6).toUpperCase() };
  const raw = token();
  await db.batch([
    db.statement('INSERT INTO cr_users(id,handle,name,salt,password_hash) VALUES(?,?,?,?,?)',
      user.id, user.handle, user.name, '', 'disabled'),
    ...campusSetup(db, user),
    db.statement('INSERT INTO cr_sessions VALUES(?,?,?)', await digest(raw), user.id, now() + guestLifetime * 1000),
  ]);
  return json({ user, spaces: campusSpaces }, 201, { 'Set-Cookie': cookie(request, raw, guestLifetime) });
}

async function membership(db, server, user) {
  const member = await db.one('SELECT role FROM cr_members WHERE server_id=? AND user_id=?', server, user);
  if (!member) reject(403, 'You aren’t a member of that server.');
  return member.role;
}

async function access(db, channel, user) {
  const result = await db.one('SELECT server_id,role FROM cr_access WHERE channel_id=? AND user_id=?', channel, user);
  if (!result) reject(403, 'You don’t have access to that channel.');
  return result;
}

function requireOwner(role) {
  if (role !== 'owner') reject(403, 'Only the server owner can do that.');
}

function roleMask(roles) {
  if (!Array.isArray(roles) || roles.length > 3 || roles.some((role) => !Object.hasOwn(roleBits, role))) {
    reject(400, 'Choose valid channel roles.');
  }
  return roles.reduce((mask, role) => mask | roleBits[role], roleBits.owner);
}

function channelName(value) {
  const result = text(value, 'Channel name', 1, 32).toLowerCase().replace(/\s+/g, '-');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(result)) reject(400, 'Channel names use letters, numbers and hyphens.');
  return result;
}

const serverList = `SELECT s.id,s.name,s.sample,m.role,
  (SELECT count(*) FROM cr_access a JOIN cr_messages msg ON msg.channel_id=a.channel_id
    LEFT JOIN cr_read_positions r ON r.channel_id=a.channel_id AND r.user_id=a.user_id
    WHERE a.server_id=s.id AND a.user_id=m.user_id AND msg.seq>coalesce(r.last_seq,0)
      AND msg.author_id!=m.user_id AND msg.deleted_at IS NULL) AS unread
  FROM cr_members m JOIN cr_servers s ON s.id=m.server_id WHERE m.user_id=? ORDER BY s.name,s.id`;

async function createServer(db, user, input) {
  const sample = input.sample === true;
  const name = sample ? 'The Fieldnotes Club' : text(input.name, 'Server name', 2, 48);
  const server = id(), category = id(), channel = id();
  const entries = [
    db.statement('INSERT INTO cr_servers VALUES(?,?,?,?)', server, name, user.id, Number(sample)),
    db.statement("INSERT INTO cr_members VALUES(?,?,'owner')", server, user.id),
    db.statement('INSERT INTO cr_categories VALUES(?,?,?,1)', category, server, 'Gathering spaces'),
    db.statement('INSERT INTO cr_channels VALUES(?,?,?,?,?,7,1)', channel, server, category, 'commons',
      sample ? 'A sample conversation for trying Commonroom.' : 'Introduce yourself and start a conversation.'),
  ];
  if (sample) {
    entries.push(
      db.statement('INSERT INTO cr_channels VALUES(?,?,?,?,?,7,2)', id(), server, category, 'field-notes', 'Share a small observation from your week.'),
      db.statement('INSERT INTO cr_channels VALUES(?,?,?,?,?,7,3)', id(), server, category, 'weekend-plans', 'Find someone to explore with.'),
    );
    for (const message of [
      'Welcome to The Fieldnotes Club. This is a sample workspace. Try a reply or a reaction on these starter messages.',
      'A small observation for today: the quietest corner of the park is also where the birds do the most talking.',
      'What did you notice this week that you might usually walk past?',
    ]) {
      entries.push(db.statement('INSERT INTO cr_messages(id,channel_id,author_id,text,created_at) VALUES(?,?,?,?,?)',
        id(), channel, user.id, message, now()));
    }
  }
  await db.batch(entries);
  return json({ id: server, channelId: channel }, 201);
}

async function serverInfo(db, server, user, role) {
  const details = await db.one('SELECT id,name,owner_id AS ownerId,sample FROM cr_servers WHERE id=?', server);
  const categories = await db.all(`SELECT c.id,c.name FROM cr_categories c JOIN cr_members m ON m.server_id=c.server_id
    WHERE c.server_id=? AND m.user_id=? ORDER BY c.position,c.id`, server, user);
  const channels = await db.all(`SELECT c.id,c.name,c.topic,c.category_id AS categoryId,c.role_mask AS roleMask,c.position,
    (SELECT count(*) FROM cr_messages msg LEFT JOIN cr_read_positions r ON r.channel_id=c.id AND r.user_id=a.user_id
      WHERE msg.channel_id=c.id AND msg.seq>coalesce(r.last_seq,0) AND msg.author_id!=a.user_id AND msg.deleted_at IS NULL) AS unread
    FROM cr_access a JOIN cr_channels c ON c.id=a.channel_id WHERE a.server_id=? AND a.user_id=? ORDER BY c.position,c.id`, server, user);
  const members = await db.all(`SELECT u.id,u.name,u.handle,m.role FROM cr_members m JOIN cr_users u ON u.id=m.user_id
    WHERE m.server_id=? AND EXISTS(SELECT 1 FROM cr_members WHERE server_id=? AND user_id=?)
    ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END,u.name,u.id`, server, server, user);
  return json({ ...details, role, categories, channels: channels.map((channel) => ({
    ...channel, readOnly: channel.id === campusSpaces.announcements && role === 'member',
  })), members });
}

async function joinServer(db, user, input) {
  const supplied = text(input.token, 'Invite code', 64, 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(supplied)) reject(400, 'Enter a valid invite code.');
  const hash = await digest(supplied);
  const time = now();
  const invite = await db.one('SELECT server_id FROM cr_invites WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?', hash, time);
  if (!invite) reject(410, 'This invite has expired or been revoked.');
  await db.run(`INSERT INTO cr_members(server_id,user_id,role)
    SELECT server_id,?,'member' FROM cr_invites WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?
    ON CONFLICT(server_id,user_id) DO NOTHING`, user.id, hash, time);
  await membership(db, invite.server_id, user.id);
  return json({ id: invite.server_id });
}

function audit(db, server, actor, action, target, conditional = true) {
  return db.statement('INSERT INTO cr_audit(server_id,actor_id,action,target,created_at) SELECT ?,?,?,?,?'
    + (conditional ? ' WHERE changes()>0' : ''), server, actor, action, target, now());
}

async function memberAction(db, server, user, role, target, method, request) {
  const member = await db.one(`SELECT m.role,u.name FROM cr_members m JOIN cr_users u ON u.id=m.user_id
    WHERE m.server_id=? AND m.user_id=?`, server, target);
  if (!member) reject(404, 'Member not found.');
  if (member.role === 'owner') reject(409, 'The server owner must remain a member.');
  if (method === 'PATCH') {
    requireOwner(role);
    const { role: newRole } = await body(request);
    if (!['member', 'moderator'].includes(newRole)) reject(400, 'Choose member or moderator.');
    const results = await db.batch([
      db.statement("UPDATE cr_members SET role=? WHERE server_id=? AND user_id=? AND role!='owner' AND role!=?"
        + " AND EXISTS(SELECT 1 FROM cr_members WHERE server_id=? AND user_id=? AND role='owner')",
      newRole, server, target, newRole, server, user.id),
      audit(db, server, user.id, 'Changed role to ' + newRole, member.name),
    ]);
    return json({ changed: Boolean(results[0].meta.changes) });
  }
  if (role === 'member' || role === 'moderator' && member.role !== 'member') reject(403, 'You can’t remove this member.');
  const results = await db.batch([
    db.statement(`DELETE FROM cr_members AS target WHERE server_id=? AND user_id=? AND role!='owner'
      AND EXISTS(SELECT 1 FROM cr_members AS actor WHERE actor.server_id=target.server_id AND actor.user_id=?
        AND (actor.role='owner' OR actor.role='moderator' AND target.role='member'))`, server, target, user.id),
    audit(db, server, user.id, 'Removed member', member.name),
  ]);
  if (!results[0].meta.changes) reject(403, 'You can’t remove this member.');
  return json({ ok: true });
}

async function serverRoute(db, request, url, user, server, resource, target) {
  const method = request.method;
  const role = await membership(db, server, user.id);
  if (!resource && method === 'GET') return serverInfo(db, server, user.id, role);
  if (resource === 'leave' && method === 'POST') {
    if (role === 'owner') reject(409, 'The server owner must remain a member.');
    await db.run("DELETE FROM cr_members WHERE server_id=? AND user_id=? AND role!='owner'", server, user.id);
    return json({ ok: true });
  }
  if (resource === 'members' && target && ['PATCH', 'DELETE'].includes(method)) return memberAction(db, server, user, role, target, method, request);
  if (resource === 'search' && method === 'GET') {
    const query = text(url.searchParams.get('q'), 'Search', 2, 80).toLowerCase();
    const matches = await db.all(`SELECT msg.id,msg.seq,msg.text,msg.created_at AS createdAt,u.name AS author,c.id AS channelId,c.name AS channel
      FROM cr_access a JOIN cr_channels c ON c.id=a.channel_id JOIN cr_messages msg ON msg.channel_id=c.id
      JOIN cr_users u ON u.id=msg.author_id WHERE a.server_id=? AND a.user_id=? AND msg.deleted_at IS NULL
      AND instr(lower(msg.text),?)>0 ORDER BY msg.seq DESC LIMIT 50`, server, user.id, query);
    return json({ matches });
  }
  if (resource === 'audit' && method === 'GET') {
    if (role === 'member') reject(403, 'Only moderators and owners can see the audit log.');
    return json({ entries: await db.all(`SELECT a.id,a.action,a.target,a.created_at AS createdAt,u.name AS actor
      FROM cr_audit a JOIN cr_users u ON u.id=a.actor_id JOIN cr_members m ON m.server_id=a.server_id
      WHERE a.server_id=? AND m.user_id=? AND m.role IN ('owner','moderator') ORDER BY a.id DESC LIMIT 60`, server, user.id) });
  }
  requireOwner(role);
  if (!resource && method === 'PATCH') {
    const { name } = await body(request);
    await db.run('UPDATE cr_servers SET name=? WHERE id=? AND owner_id=?', text(name, 'Server name', 2, 48), server, user.id);
    return json({ ok: true });
  }
  if (resource === 'categories' && method === 'POST') {
    const { name } = await body(request);
    const category = id();
    await db.run(`INSERT INTO cr_categories SELECT ?,?,?,coalesce(max(position),0)+1
      FROM cr_categories WHERE server_id=?`, category, server, text(name, 'Category name', 2, 36), server);
    return json({ id: category }, 201);
  }
  if (resource === 'channels' && method === 'POST') {
    const input = await body(request);
    if (!await db.one('SELECT id FROM cr_categories WHERE id=? AND server_id=?', text(input.categoryId, 'Category', 36, 36), server)) {
      reject(400, 'Choose a category in this server.');
    }
    const channel = id();
    await db.run(`INSERT INTO cr_channels SELECT ?,?,?,?,?,?,coalesce(max(position),0)+1
      FROM cr_channels WHERE category_id=?`, channel, server, input.categoryId, channelName(input.name),
    text(input.topic ?? '', 'Topic', 0, 160), roleMask(input.allowedRoles), input.categoryId);
    return json({ id: channel }, 201);
  }
  if (resource === 'invites' && method === 'GET') {
    return json({ invites: await db.all(`SELECT id,expires_at AS expiresAt,revoked_at AS revokedAt,created_at AS createdAt
      FROM cr_invites WHERE server_id=? ORDER BY created_at DESC LIMIT 30`, server) });
  }
  if (resource === 'invites' && method === 'POST') {
    const input = await body(request);
    const expiresAt = now() + number(input.hours, 'Invite duration', 1, 168) * 3_600_000;
    const invite = id(), raw = token();
    await db.run('INSERT INTO cr_invites VALUES(?,?,?,?,NULL,?)', invite, server, await digest(raw), expiresAt, now());
    return json({ id: invite, token: raw, expiresAt }, 201);
  }
  if (resource === 'invites' && method === 'DELETE' && target) {
    const changed = await db.run('UPDATE cr_invites SET revoked_at=? WHERE id=? AND server_id=? AND revoked_at IS NULL', now(), target, server);
    if (!changed) reject(404, 'No active invite matches.');
    return json({ ok: true });
  }
  reject(404, 'This action isn’t available.');
}

const messageRows = `SELECT m.id,m.seq,m.text,m.author_id AS authorId,u.name AS author,
    m.created_at AS createdAt,m.edited_at AS editedAt,m.deleted_at AS deletedAt,m.reply_to_id AS replyToId,
    CASE WHEN quoted.deleted_at IS NULL THEN substr(quoted.text,1,140) ELSE '' END AS replyText,
    qu.name AS replyAuthor,
    (SELECT json_group_array(json_object('emoji',g.emoji,'count',g.total,'mine',g.mine)) FROM
      (SELECT emoji,count(*) AS total,max(user_id=a.user_id) AS mine FROM cr_reactions
        WHERE message_id=m.id GROUP BY emoji) g) AS reactions
  FROM cr_messages m JOIN cr_access a ON a.channel_id=m.channel_id AND a.user_id=?
  JOIN cr_users u ON u.id=m.author_id LEFT JOIN cr_messages quoted ON quoted.id=m.reply_to_id
  LEFT JOIN cr_users qu ON qu.id=quoted.author_id WHERE m.channel_id=?`;

function messageData(row) {
  return { ...row, reactions: row.deletedAt ? [] : JSON.parse(row.reactions || '[]') };
}

async function oneMessage(db, user, channel, message) {
  const row = await db.one(messageRows + ' AND m.id=?', user, channel, message);
  if (!row) reject(403, 'You don’t have access to this message.');
  return messageData(row);
}

async function feed(db, url, user, channel) {
  if (url.searchParams.has('cursor')) {
    const cursor = number(Number(url.searchParams.get('cursor')), 'Update position', 0, Number.MAX_SAFE_INTEGER);
    const events = await db.all(`SELECT e.seq,e.message_id FROM cr_changes e JOIN cr_access a ON a.channel_id=e.channel_id
      WHERE e.channel_id=? AND e.seq>? AND a.user_id=? ORDER BY e.seq LIMIT 61`, channel, cursor, user.id);
    const page = events.slice(0, 60);
    if (!page.length) return json({ messages: [], cursor, more: false });
    const ids = [...new Set(page.map((event) => event.message_id))];
    const rows = await db.all(messageRows + ' AND m.id IN (' + ids.map(() => '?').join(',') + ') ORDER BY m.seq',
      user.id, channel, ...ids);
    return json({ messages: rows.map(messageData), cursor: page.at(-1).seq, more: events.length > page.length });
  }
  const before = url.searchParams.has('before')
    ? number(Number(url.searchParams.get('before')), 'History position', 1, Number.MAX_SAFE_INTEGER)
    : Number.MAX_SAFE_INTEGER;
  const watermark = await db.one('SELECT coalesce(max(seq),0) AS cursor FROM cr_changes WHERE channel_id=?', channel);
  const rows = await db.all(messageRows + ' AND m.seq<? ORDER BY m.seq DESC LIMIT 41', user.id, channel, before);
  return json({ messages: rows.slice(0, 40).reverse().map(messageData), cursor: watermark.cursor, hasOlder: rows.length > 40 });
}

async function sendMessage(db, request, user, channel) {
  const input = await body(request);
  if (typeof input.id !== 'string' || !uuid.test(input.id)) reject(400, 'Invalid message identifier.');
  const content = text(input.text, 'Message', 1, 2000);
  const existing = await db.one('SELECT author_id,channel_id FROM cr_messages WHERE id=?', input.id);
  if (existing) {
    if (existing.author_id !== user.id || existing.channel_id !== channel) reject(409, 'That message identifier is already used.');
    return json({ message: await oneMessage(db, user.id, channel, input.id) });
  }
  const reply = input.replyToId || null;
  if (reply && (typeof reply !== 'string' || !uuid.test(reply)
    || !await db.one('SELECT id FROM cr_messages WHERE id=? AND channel_id=? AND deleted_at IS NULL', reply, channel))) {
    reject(400, 'Choose a reply from this channel.');
  }
  await rate(db, 'messages:' + user.id, 8, 10_000);
  const created = await db.run(`INSERT INTO cr_messages(id,channel_id,author_id,reply_to_id,text,created_at)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM cr_access WHERE channel_id=? AND user_id=?)
      AND (? IS NULL OR EXISTS(SELECT 1 FROM cr_messages WHERE id=? AND channel_id=? AND deleted_at IS NULL))
    ON CONFLICT(id) DO NOTHING`, input.id, channel, user.id, reply, content, now(), channel, user.id, reply, reply, channel);
  const saved = await oneMessage(db, user.id, channel, input.id);
  if (saved.authorId !== user.id) reject(409, 'That message identifier is already used.');
  return json({ message: saved }, created ? 201 : 200);
}

async function reorder(db, request, channel, server) {
  const { direction } = await body(request);
  if (!['up', 'down'].includes(direction)) reject(400, 'Choose an order direction.');
  const current = await db.one('SELECT id,category_id,position FROM cr_channels WHERE id=? AND server_id=?', channel, server);
  const up = direction === 'up';
  const other = await db.one(`SELECT id,position FROM cr_channels WHERE category_id=? AND (position,id) `
    + (up ? '<' : '>') + ' (?,?) ORDER BY ' + (up ? 'position DESC,id DESC' : 'position,id') + ' LIMIT 1',
  current.category_id, current.position, current.id);
  if (!other) return json({ moved: false });
  const changes = await db.run(`WITH selected AS MATERIALIZED (
    SELECT id,position FROM cr_channels WHERE (id=? AND position=?) OR (id=? AND position=?)
  ) UPDATE cr_channels SET position=CASE id WHEN ? THEN ? ELSE ? END
  WHERE id IN (?,?) AND (SELECT count(*) FROM selected)=2`, current.id, current.position, other.id, other.position,
  current.id, other.position, current.position, current.id, other.id);
  if (!changes) reject(409, 'The channel order changed. Refresh and try again.');
  return json({ moved: true });
}

async function channelRoute(db, request, url, user, channel, resource) {
  const { server_id: server, role } = await access(db, channel, user.id);
  if (resource === 'messages' && request.method === 'GET') return feed(db, url, user, channel);
  if (resource === 'messages' && request.method === 'POST') {
    if (channel === campusSpaces.announcements && role === 'member') reject(403, 'Only the workspace team can post announcements.');
    return sendMessage(db, request, user, channel);
  }
  if (resource === 'read' && request.method === 'POST') {
    const input = await body(request);
    const seq = number(input.seq, 'Read position', 0, Number.MAX_SAFE_INTEGER);
    await db.run(`INSERT INTO cr_read_positions(channel_id,user_id,last_seq)
      SELECT ?,?,min(?,coalesce((SELECT max(seq) FROM cr_messages WHERE channel_id=?),0))
      WHERE EXISTS(SELECT 1 FROM cr_access WHERE user_id=? AND channel_id=?)
      ON CONFLICT(channel_id,user_id) DO UPDATE SET last_seq=max(last_seq,excluded.last_seq)`,
    channel, user.id, seq, channel, user.id, channel);
    return json({ ok: true });
  }
  requireOwner(role);
  if (resource === 'order' && request.method === 'POST') return reorder(db, request, channel, server);
  if (!resource && request.method === 'PATCH') {
    const input = await body(request);
    await db.run('UPDATE cr_channels SET name=?,topic=?,role_mask=? WHERE id=? AND server_id=?',
      channelName(input.name), text(input.topic ?? '', 'Topic', 0, 160), roleMask(input.allowedRoles), channel, server);
    return json({ ok: true });
  }
  reject(404, 'This action isn’t available.');
}

async function messageRoute(db, request, user, message, resource) {
  const row = await db.one(`SELECT m.channel_id,m.author_id,m.edited_at,m.deleted_at,a.server_id,a.role,c.name AS channel
    FROM cr_messages m JOIN cr_access a ON a.channel_id=m.channel_id JOIN cr_channels c ON c.id=m.channel_id
    WHERE m.id=? AND a.user_id=?`, message, user.id);
  if (!row) reject(403, 'You don’t have access to that message.');
  const mine = row.author_id === user.id;
  if (resource === 'reaction' && request.method === 'PUT' && !row.deleted_at) {
    const { emoji, active } = await body(request);
    if (!emojis.includes(emoji) || typeof active !== 'boolean') reject(400, 'Choose a supported reaction.');
    await rate(db, 'reactions:' + user.id, 40, 10_000);
    if (active) {
      await db.run(`INSERT INTO cr_reactions SELECT ?,?,? WHERE EXISTS(
        SELECT 1 FROM cr_messages m JOIN cr_access a ON a.channel_id=m.channel_id
        WHERE m.id=? AND a.user_id=? AND m.deleted_at IS NULL) ON CONFLICT DO NOTHING`, message, user.id, emoji, message, user.id);
    } else {
      await db.run(`DELETE FROM cr_reactions WHERE message_id=? AND user_id=? AND emoji=?
        AND EXISTS(SELECT 1 FROM cr_access WHERE channel_id=? AND user_id=?)`, message, user.id, emoji, row.channel_id, user.id);
    }
    return json({ message: await oneMessage(db, user.id, row.channel_id, message) });
  }
  if (!resource && request.method === 'PATCH') {
    if (!mine || row.deleted_at) reject(403, 'You can only edit your own visible messages.');
    const input = await body(request);
    const content = text(input.text, 'Message', 1, 2000);
    const expected = input.editedAt === undefined ? row.edited_at : input.editedAt;
    if (expected !== null) number(expected, 'Edit version', 0, Number.MAX_SAFE_INTEGER);
    if (expected !== row.edited_at) reject(409, 'That message has a newer edit. Reopen it before saving again.');
    const editedAt = Math.max(now(), (row.edited_at ?? 0) + 1);
    const changes = await db.run(`UPDATE cr_messages SET text=?,edited_at=?
      WHERE id=? AND author_id=? AND edited_at IS ? AND deleted_at IS NULL AND EXISTS(
        SELECT 1 FROM cr_access WHERE channel_id=cr_messages.channel_id AND user_id=?)`,
    content, editedAt, message, user.id, expected, user.id);
    if (!changes) reject(409, 'That message changed. Refresh and try again.');
    return json({ message: await oneMessage(db, user.id, row.channel_id, message) });
  }
  if (!resource && request.method === 'DELETE') {
    if (!mine && row.role === 'member') reject(403, 'Only moderators can remove other members’ messages.');
    const mutation = db.statement(`UPDATE cr_messages SET text='',deleted_at=?
      WHERE id=? AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM cr_access a
        WHERE a.channel_id=cr_messages.channel_id AND a.user_id=? AND (a.role!='member' OR cr_messages.author_id=?))`,
    now(), message, user.id, user.id);
    const [result] = await db.batch(mine ? [mutation]
      : [mutation, audit(db, row.server_id, user.id, 'Removed message in #' + row.channel, message)]);
    const latest = await oneMessage(db, user.id, row.channel_id, message);
    if (!result.meta.changes && !latest.deletedAt) reject(403, 'You no longer have permission to remove this message.');
    return json({ message: latest });
  }
  reject(404, 'This action isn’t available.');
}

const threadRows = `SELECT t.id,t.title,t.text,t.scope,t.channel_id AS channelId,u.name AS author,t.created_at AS createdAt,
    (SELECT count(*) FROM cr_thread_replies r WHERE r.thread_id=t.id) AS replyCount,
    (SELECT count(*) FROM cr_thread_stances s WHERE s.thread_id=t.id AND s.stance='agree') AS agreeCount,
    (SELECT count(*) FROM cr_thread_stances s WHERE s.thread_id=t.id AND s.stance='disagree') AS disagreeCount,
    mine.stance
  FROM cr_threads t JOIN cr_access a ON a.channel_id=t.channel_id AND a.user_id=?
  JOIN cr_users u ON u.id=t.author_id
  LEFT JOIN cr_thread_stances mine ON mine.thread_id=t.id AND mine.user_id=a.user_id`;

async function threadInfo(db, user, thread, kind) {
  const record = await db.one(threadRows + ' WHERE t.id=? AND t.kind=?', user, thread, kind);
  if (!record) reject(404, 'This discussion is unavailable.');
  return record;
}

function forumId(value) {
  if (typeof value !== 'string' || !uuid.test(value)) reject(400, 'Invalid post identifier.');
  return value;
}

async function createThread(db, request, user, kind) {
  const input = await body(request);
  const thread = forumId(input.id);
  const title = text(input.title, 'Title', 3, 100);
  const content = text(input.text, kind === 'help' ? 'Question' : 'Issue', 3, 2400);
  if (typeof input.scope !== 'string' || !Object.hasOwn(threadScopes, input.scope)) reject(400, 'Choose a valid discussion space.');
  const channel = threadScopes[input.scope];
  await access(db, channel, user.id);
  const existing = await db.one('SELECT channel_id,author_id,kind FROM cr_threads WHERE id=?', thread);
  if (existing) {
    if (existing.author_id !== user.id || existing.channel_id !== channel || existing.kind !== kind) reject(409, 'That post identifier is already used.');
    return json({ thread: await threadInfo(db, user.id, thread, kind) });
  }
  await rate(db, 'threads:' + user.id, 5, 60_000);
  const created = await db.run(`INSERT INTO cr_threads(id,channel_id,author_id,scope,title,text,created_at,kind)
    SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM cr_access WHERE channel_id=? AND user_id=?)
    ON CONFLICT(id) DO NOTHING`, thread, channel, user.id, input.scope, title, content, now(), kind, channel, user.id);
  const saved = await db.one('SELECT channel_id,author_id,kind FROM cr_threads WHERE id=?', thread);
  if (!saved) reject(403, 'You no longer have access to that discussion space.');
  if (saved.author_id !== user.id || saved.channel_id !== channel || saved.kind !== kind) reject(409, 'That post identifier is already used.');
  return json({ thread: await threadInfo(db, user.id, thread, kind) }, created ? 201 : 200);
}

const replyRows = `SELECT r.id,r.text,u.name AS author,r.created_at AS createdAt
  FROM cr_thread_replies r JOIN cr_threads t ON t.id=r.thread_id
  JOIN cr_access a ON a.channel_id=t.channel_id AND a.user_id=? JOIN cr_users u ON u.id=r.author_id
  WHERE r.thread_id=?`;

async function createThreadReply(db, request, user, thread) {
  const input = await body(request);
  const reply = forumId(input.id);
  const content = text(input.text, 'Response', 1, 1600);
  const previous = await db.one('SELECT thread_id,author_id FROM cr_thread_replies WHERE id=?', reply);
  if (previous) {
    if (previous.thread_id !== thread.id || previous.author_id !== user.id) reject(409, 'That response identifier is already used.');
    const record = await db.one(replyRows + ' AND r.id=?', user.id, thread.id, reply);
    if (!record) reject(403, 'You no longer have access to that discussion.');
    return json({ reply: record });
  }
  await rate(db, 'thread-replies:' + user.id, 12, 15_000);
  const created = await db.run(`INSERT INTO cr_thread_replies(id,thread_id,author_id,text,created_at)
    SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM cr_access WHERE channel_id=? AND user_id=?)
    ON CONFLICT(id) DO NOTHING`, reply, thread.id, user.id, content, now(), thread.channelId, user.id);
  const saved = await db.one('SELECT thread_id,author_id FROM cr_thread_replies WHERE id=?', reply);
  if (!saved) reject(403, 'You no longer have access to that discussion.');
  if (saved.thread_id !== thread.id || saved.author_id !== user.id) reject(409, 'That response identifier is already used.');
  const record = await db.one(replyRows + ' AND r.id=?', user.id, thread.id, reply);
  if (!record) reject(403, 'You no longer have access to that discussion.');
  return json({ reply: record }, created ? 201 : 200);
}

async function forumRoute(db, request, user, item, resource, kind) {
  const method = request.method;
  if (!item) {
    if (method === 'GET') {
      const threads = await db.all(threadRows + ' WHERE t.kind=? ORDER BY t.created_at DESC,t.id DESC LIMIT 60', user.id, kind);
      return json({ threads });
    }
    if (method === 'POST') return createThread(db, request, user, kind);
    reject(404, 'That discussion action isn’t available.');
  }

  const thread = await threadInfo(db, user.id, item, kind);
  if (!resource && method === 'GET') {
    const replies = await db.all(replyRows + ' ORDER BY r.created_at DESC,r.id DESC LIMIT 200', user.id, item);
    return json({ thread, replies: replies.reverse() });
  }
  if (resource === 'replies' && method === 'POST') return createThreadReply(db, request, user, thread);
  if (kind === 'issue' && resource === 'stance' && method === 'PUT') {
    const { stance } = await body(request);
    if (![null, 'agree', 'disagree'].includes(stance)) reject(400, 'Choose agree, disagree, or clear your response.');
    await rate(db, 'thread-stances:' + user.id, 25, 15_000);
    if (stance === null) {
      await db.run(`DELETE FROM cr_thread_stances WHERE thread_id=? AND user_id=? AND EXISTS(
        SELECT 1 FROM cr_access WHERE channel_id=? AND user_id=?)`, item, user.id, thread.channelId, user.id);
    } else {
      await db.run(`INSERT INTO cr_thread_stances(thread_id,user_id,stance)
        SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM cr_access WHERE channel_id=? AND user_id=?)
        ON CONFLICT(thread_id,user_id) DO UPDATE SET stance=excluded.stance`,
      item, user.id, stance, thread.channelId, user.id);
    }
    return json({ thread: await threadInfo(db, user.id, item, kind) });
  }
  reject(404, 'That discussion action isn’t available.');
}

export async function handleApi(request, binding) {
  try {
    if (!binding) reject(503, 'Commonroom’s database is unavailable. Check the DB binding and migrations.');
    const db = database(binding);
    const url = new URL(request.url);
    const path = url.pathname.slice(5).split('/');
    const [area, item, resource, target] = path;
    const method = request.method;
    const origin = request.headers.get('Origin');
    if (method !== 'GET' && (origin && origin !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site')) {
      reject(403, 'Open Commonroom directly to make changes.');
    }
    if (area === 'health' && method === 'GET' && path.length === 1) {
      await db.one(`SELECT EXISTS(SELECT 1 FROM cr_users),EXISTS(SELECT kind FROM cr_threads),
        EXISTS(SELECT 1 FROM cr_thread_replies),EXISTS(SELECT 1 FROM cr_thread_stances)`);
      return json({ ok: true });
    }
    if (area === 'auth' && method === 'POST' && path.length === 2) {
      if (item === 'register' || item === 'login') return await login(db, request, item === 'register');
      if (item === 'guest') return await guest(db, request);
      if (item === 'logout') {
        const raw = sessionToken(request);
        if (raw) await db.run('DELETE FROM cr_sessions WHERE token_hash=?', await digest(raw));
        return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, '', 0) });
      }
    }
    const user = await authenticate(db, request);
    if (['threads', 'help'].includes(area) && path.length <= 3 && (path.length === 1 || uuid.test(item))) {
      return await forumRoute(db, request, user, item, resource, area === 'help' ? 'help' : 'issue');
    }
    if (area === 'me' && method === 'GET' && path.length === 1) return json({ user });
    if (area === 'join' && method === 'POST' && path.length === 1) return await joinServer(db, user, await body(request));
    if (area === 'servers' && path.length === 1) {
      if (method === 'GET') return json({ servers: await db.all(serverList, user.id) });
      if (method === 'POST') return await createServer(db, user, await body(request));
    }
    if (item && uuid.test(item)) {
      if (area === 'servers' && path.length <= 4 && (!target || uuid.test(target))) return await serverRoute(db, request, url, user, item, resource, target);
      if (area === 'channels' && path.length <= 3) return await channelRoute(db, request, url, user, item, resource);
      if (area === 'messages' && path.length <= 3) return await messageRoute(db, request, user, item, resource);
    }
    reject(404, 'That Commonroom route does not exist.');
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    console.error('Commonroom API request failed:', error?.name, error?.message?.slice(0, 250));
    return json({ error: 'Commonroom couldn’t complete that request. Try again.' }, 500);
  }
}
