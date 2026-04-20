#!/usr/bin/env node
/** E2E Bloco 04 — Teams CRUD + member + round-robin assign. */
const API = 'http://localhost:3200';
const stamp = Date.now();
let fails = 0;
function assert(cond, msg) { if (cond) console.log('OK:', msg); else { console.error('FAIL:', msg); fails++; } }

async function login(email = 'victorfujiyama@gmail.com', password = 'w170598') {
  const r = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return (await r.json()).accessToken;
}
async function api(path, opts = {}, token) {
  const headers = { ...(opts.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.body && typeof opts.body !== 'string') {
    headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  return fetch(`${API}${path}`, { ...opts, headers });
}

const token = await login();

// Create team
let r = await api('/api/v1/teams', {
  method: 'POST',
  body: { name: `Suporte${stamp}`, description: 'Time de suporte' },
}, token);
assert(r.status === 201, `create team (${r.status})`);
const team = await r.json();

// Dup
r = await api('/api/v1/teams', { method: 'POST', body: { name: `Suporte${stamp}` } }, token);
assert(r.status === 409, `dup team name (${r.status})`);

// Create two agents
const agentA = `agA${stamp}@blossom.test`;
const agentB = `agB${stamp}@blossom.test`;
r = await api('/api/v1/users', { method: 'POST', body: { email: agentA, name: 'Agente A', password: 'pass12345', role: 'agent', status: 'online' } }, token);
const userA = await r.json();
r = await api('/api/v1/users', { method: 'POST', body: { email: agentB, name: 'Agente B', password: 'pass12345', role: 'agent', status: 'online' } }, token);
const userB = await r.json();

// Add members
r = await api(`/api/v1/teams/${team.id}/members`, { method: 'POST', body: { userId: userA.id } }, token);
assert(r.status === 204, `add member A (${r.status})`);
r = await api(`/api/v1/teams/${team.id}/members`, { method: 'POST', body: { userId: userB.id } }, token);
assert(r.status === 204, `add member B (${r.status})`);

// Get team detail shows members
r = await api(`/api/v1/teams/${team.id}`, {}, token);
const detail = await r.json();
assert(detail.members?.length === 2, `team has 2 members (got ${detail.members?.length})`);

// Round-robin assign 4x — should alternate between A and B (sorted by userId)
const ids = [userA.id, userB.id].sort();
r = await api('/api/v1/conversations?limit=4', {}, token);
const convs = (await r.json()).items;
if (convs.length >= 2) {
  const assigned = [];
  for (const c of convs.slice(0, 4)) {
    r = await api(`/api/v1/teams/${team.id}/assign-conversation`, {
      method: 'POST', body: { conversationId: c.id },
    }, token);
    if (r.ok) {
      const res = await r.json();
      assigned.push(res.assignedUserId);
    }
  }
  // Expect distribution
  const countA = assigned.filter((u) => u === ids[0]).length;
  const countB = assigned.filter((u) => u === ids[1]).length;
  assert(countA > 0 && countB > 0, `round-robin distributes (A=${countA}, B=${countB})`);
  assert(Math.abs(countA - countB) <= 1, `round-robin balanced within 1 (A=${countA}, B=${countB})`);
}

// Remove member
r = await api(`/api/v1/teams/${team.id}/members/${userA.id}`, { method: 'DELETE' }, token);
assert(r.status === 204, `remove member (${r.status})`);

// Delete team
r = await api(`/api/v1/teams/${team.id}`, { method: 'DELETE' }, token);
assert(r.status === 204, `delete team (${r.status})`);

if (fails === 0) console.log('\nALL GREEN');
else { console.log(`\n${fails} FAILURES`); process.exit(1); }
