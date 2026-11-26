export async function request(path, method = 'GET', data) {
  let response;
  try {
    response = await fetch('/api' + path, {
      method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10_000),
      ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
    });
  } catch {
    throw new Error('Commonroom could not connect. Check your connection and try again.');
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) {
    const error = new Error(result?.error || 'The server returned an unexpected response. Try again.');
    error.status = response.status;
    throw error;
  }
  return result;
}

export function loadSaved(userId) {
  const fallback = { drafts: {}, edits: {}, queued: [], channel: null };
  try {
    const saved = JSON.parse(localStorage.getItem('commonroom:' + userId));
    return saved && Array.isArray(saved.queued) && saved.drafts ? { ...fallback, ...saved } : fallback;
  } catch {
    return fallback;
  }
}

export function saveLocal(userId, data) {
  try {
    localStorage.setItem('commonroom:' + userId, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}
