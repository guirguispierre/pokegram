// pokegram REST API
import { Env, Agent, Post, nanoid, now, json, err } from './types';
import { deleteAgentApiKey, issueAgentApiKey, requireAgentAuth } from './auth';

interface AgentAuthPayload {
  agent: Agent;
  api_key: string;
}

interface AgentApiKeyRotationPayload {
  agent_id: string;
  api_key: string;
}

interface CreateAgentBody {
  handle: string;
  bio?: string;
  personality?: string;
  avatar_seed?: string;
  external_agent_id?: string;
}

interface AgentIdentityRow {
  id: string;
  external_agent_id: string | null;
}

const AGENT_PUBLIC_COLUMNS = `
  id,
  handle,
  bio,
  personality,
  avatar_seed,
  post_count,
  follower_count,
  following_count,
  created_at
`;

async function requireAgentMutationAuth(
  req: Request,
  env: Env,
  agentId: string,
  skipAuth = false
): Promise<Response | null> {
  if (skipAuth) return null;
  return requireAgentAuth(req, env, agentId);
}

function normalizeHandle(handle: string): string {
  return handle.toLowerCase().replace(/[^a-z0-9_]/g, '');
}

async function rebuildCounters(env: Env): Promise<void> {
  await env.DB.prepare(
    'UPDATE agents SET post_count = 0, follower_count = 0, following_count = 0'
  ).run();
  await env.DB.prepare(
    `UPDATE agents
     SET post_count = (SELECT COUNT(*) FROM posts WHERE posts.agent_id = agents.id),
         follower_count = (SELECT COUNT(*) FROM follows WHERE follows.following_id = agents.id),
         following_count = (SELECT COUNT(*) FROM follows WHERE follows.follower_id = agents.id)`
  ).run();

  await env.DB.prepare(
    'UPDATE posts SET like_count = 0, reply_count = 0'
  ).run();
  await env.DB.prepare(
    `UPDATE posts
     SET like_count = (SELECT COUNT(*) FROM likes WHERE likes.post_id = posts.id),
         reply_count = (SELECT COUNT(*) FROM posts replies WHERE replies.reply_to = posts.id)`
  ).run();
}

async function deletePostTree(postId: string, env: Env): Promise<boolean> {
  const { results } = await env.DB.prepare(
    `WITH RECURSIVE post_tree(id, depth) AS (
       SELECT id, 0 FROM posts WHERE id = ?
       UNION ALL
       SELECT child.id, post_tree.depth + 1
       FROM posts child
       JOIN post_tree ON child.reply_to = post_tree.id
     )
     SELECT id, depth FROM post_tree ORDER BY depth DESC`
  ).bind(postId).all<{ id: string; depth: number }>();

  if (!results.length) return false;

  for (const post of results) {
    await env.DB.prepare('DELETE FROM likes WHERE post_id = ?').bind(post.id).run();
  }

  for (const post of results) {
    await env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(post.id).run();
  }

  await rebuildCounters(env);
  return true;
}

// ── Agents ────────────────────────────────────────────────────────────────────

export async function createAgent(req: Request, env: Env): Promise<Response> {
  const body = await req.json<CreateAgentBody>();
  if (!body.handle) return err('handle is required');
  if (body.handle.length > 32) return err('handle must be 32 chars or fewer');
  if ((body.bio?.length ?? 0) > 280) return err('bio must be 280 chars or fewer');
  if ((body.personality?.length ?? 0) > 1000) return err('personality must be 1000 chars or fewer');

  const externalAgentId = typeof body.external_agent_id === 'string'
    ? body.external_agent_id.trim()
    : '';
  if (body.external_agent_id !== undefined && !externalAgentId) {
    return err('external_agent_id must not be empty');
  }
  if (externalAgentId.length > 128) {
    return err('external_agent_id must be 128 chars or fewer');
  }

  if (externalAgentId) {
    const existingAgent = await env.DB.prepare(
      `SELECT ${AGENT_PUBLIC_COLUMNS} FROM agents WHERE external_agent_id = ?`
    ).bind(externalAgentId).first<Agent>();

    if (existingAgent) {
      const apiKey = await issueAgentApiKey(env, existingAgent.id);
      return json<AgentAuthPayload>({ ok: true, data: { agent: existingAgent, api_key: apiKey } });
    }
  }

  const handle = normalizeHandle(body.handle);
  if (!handle) return err('handle must include letters, numbers, or underscores');

  const existing = await env.DB.prepare(
    'SELECT id, external_agent_id FROM agents WHERE handle = ?'
  ).bind(handle).first<AgentIdentityRow>();
  if (existing) {
    if (externalAgentId && !existing.external_agent_id) {
      await env.DB.prepare(
        'UPDATE agents SET external_agent_id = ? WHERE id = ?'
      ).bind(externalAgentId, existing.id).run();

      const claimedAgent = await env.DB.prepare(
        `SELECT ${AGENT_PUBLIC_COLUMNS} FROM agents WHERE id = ?`
      ).bind(existing.id).first<Agent>();
      const apiKey = await issueAgentApiKey(env, existing.id);
      return json<AgentAuthPayload>({ ok: true, data: { agent: claimedAgent!, api_key: apiKey } });
    }

    return err('handle already exists', 409);
  }

  const id = nanoid();
  await env.DB.prepare(
    `INSERT INTO agents (id, handle, external_agent_id, bio, personality, avatar_seed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    handle,
    externalAgentId || null,
    body.bio ?? '',
    body.personality ?? '',
    body.avatar_seed ?? nanoid(8),
    now()
  ).run();

  const agent = await env.DB.prepare(
    `SELECT ${AGENT_PUBLIC_COLUMNS} FROM agents WHERE id = ?`
  ).bind(id).first<Agent>();
  const apiKey = await issueAgentApiKey(env, id);
  return json<AgentAuthPayload>({ ok: true, data: { agent: agent!, api_key: apiKey } }, 201);
}

export async function getAgent(handle: string, env: Env): Promise<Response> {
  const agent = await env.DB.prepare(
    `SELECT ${AGENT_PUBLIC_COLUMNS} FROM agents WHERE handle = ?`
  ).bind(handle).first<Agent>();
  if (!agent) return err('agent not found', 404);
  return json({ ok: true, data: agent });
}

export async function updateAgent(
  agentId: string,
  req: Request,
  env: Env,
  skipAuth = false
): Promise<Response> {
  const agent = await env.DB.prepare(
    'SELECT * FROM agents WHERE id = ?'
  ).bind(agentId).first<Agent>();
  if (!agent) return err('agent not found', 404);

  const authError = await requireAgentMutationAuth(req, env, agentId, skipAuth);
  if (authError) return authError;

  const body = await req.json<Partial<Agent>>();
  const updates: string[] = [];
  const values: string[] = [];

  if (typeof body.handle === 'string') {
    if (body.handle.length > 32) return err('handle must be 32 chars or fewer');
    const handle = normalizeHandle(body.handle);
    if (!handle) return err('handle must include letters, numbers, or underscores');

    const existing = await env.DB.prepare(
      'SELECT id FROM agents WHERE handle = ? AND id != ?'
    ).bind(handle, agentId).first();
    if (existing) return err('handle already exists', 409);

    updates.push('handle = ?');
    values.push(handle);
  }

  if (typeof body.bio === 'string') {
    if (body.bio.length > 280) return err('bio must be 280 chars or fewer');
    updates.push('bio = ?');
    values.push(body.bio);
  }

  if (typeof body.personality === 'string') {
    if (body.personality.length > 1000) return err('personality must be 1000 chars or fewer');
    updates.push('personality = ?');
    values.push(body.personality);
  }

  if (typeof body.avatar_seed === 'string') {
    if (body.avatar_seed.length > 64) return err('avatar_seed must be 64 chars or fewer');
    updates.push('avatar_seed = ?');
    values.push(body.avatar_seed);
  }

  if (!updates.length) return err('no updatable fields provided');

  await env.DB.prepare(
    `UPDATE agents SET ${updates.join(', ')} WHERE id = ?`
  ).bind(...values, agentId).run();

  const updated = await env.DB.prepare(
    `SELECT ${AGENT_PUBLIC_COLUMNS} FROM agents WHERE id = ?`
  ).bind(agentId).first<Agent>();
  return json({ ok: true, data: updated });
}

export async function rotateAgentApiKey(agentId: string, req: Request, env: Env): Promise<Response> {
  const agent = await env.DB.prepare(
    'SELECT id FROM agents WHERE id = ?'
  ).bind(agentId).first();
  if (!agent) return err('agent not found', 404);

  const existingKey = await env.DB.prepare(
    'SELECT agent_id FROM agent_api_keys WHERE agent_id = ?'
  ).bind(agentId).first();

  if (existingKey) {
    const authError = await requireAgentAuth(req, env, agentId);
    if (authError) return authError;
  }

  const apiKey = await issueAgentApiKey(env, agentId);
  return json<AgentApiKeyRotationPayload>({ ok: true, data: { agent_id: agentId, api_key: apiKey } });
}

export async function deleteAgent(
  agentId: string,
  req: Request,
  env: Env,
  skipAuth = false
): Promise<Response> {
  const agent = await env.DB.prepare(
    'SELECT * FROM agents WHERE id = ?'
  ).bind(agentId).first<Agent>();
  if (!agent) return err('agent not found', 404);

  const authError = await requireAgentMutationAuth(req, env, agentId, skipAuth);
  if (authError) return authError;

  const { results: ownedPosts } = await env.DB.prepare(
    'SELECT id FROM posts WHERE agent_id = ? ORDER BY created_at DESC'
  ).bind(agentId).all<{ id: string }>();

  for (const post of ownedPosts) {
    await deletePostTree(post.id, env);
  }

  await env.DB.prepare(
    'DELETE FROM likes WHERE agent_id = ?'
  ).bind(agentId).run();
  await env.DB.prepare(
    'DELETE FROM follows WHERE follower_id = ? OR following_id = ?'
  ).bind(agentId, agentId).run();
  await deleteAgentApiKey(env, agentId);
  await env.DB.prepare(
    'DELETE FROM agents WHERE id = ?'
  ).bind(agentId).run();

  await rebuildCounters(env);
  return json({ ok: true, data: { deleted: agentId, handle: agent.handle } });
}

export async function listAgents(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 100);
  const { results } = await env.DB.prepare(
    `SELECT ${AGENT_PUBLIC_COLUMNS} FROM agents ORDER BY created_at DESC LIMIT ?`
  ).bind(limit).all<Agent>();
  return json({ ok: true, data: results });
}

// ── Posts ─────────────────────────────────────────────────────────────────────

export async function createPost(req: Request, env: Env, skipAuth = false): Promise<Response> {
  const body = await req.json<{ agent_id: string; content: string; reply_to?: string }>();
  if (!body.agent_id) return err('agent_id is required');
  if (!body.content) return err('content is required');
  if (body.content.length > 500) return err('content must be 500 chars or fewer');

  const authError = await requireAgentMutationAuth(req, env, body.agent_id, skipAuth);
  if (authError) return authError;

  const agent = await env.DB.prepare('SELECT id FROM agents WHERE id = ?').bind(body.agent_id).first();
  if (!agent) return err('agent not found', 404);

  if (body.reply_to) {
    const parent = await env.DB.prepare('SELECT id FROM posts WHERE id = ?').bind(body.reply_to).first();
    if (!parent) return err('parent post not found', 404);
  }

  const id = nanoid();
  const ts = now();

  await env.DB.prepare(
    `INSERT INTO posts (id, agent_id, content, reply_to, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(id, body.agent_id, body.content, body.reply_to ?? null, ts).run();

  // Update counters
  await env.DB.prepare(
    'UPDATE agents SET post_count = post_count + 1 WHERE id = ?'
  ).bind(body.agent_id).run();

  if (body.reply_to) {
    await env.DB.prepare(
      'UPDATE posts SET reply_count = reply_count + 1 WHERE id = ?'
    ).bind(body.reply_to).run();
  }

  const post = await env.DB.prepare(
    `SELECT p.*, a.handle as agent_handle, a.bio as agent_bio
     FROM posts p JOIN agents a ON p.agent_id = a.id WHERE p.id = ?`
  ).bind(id).first<Post>();
  return json({ ok: true, data: post }, 201);
}

export async function getPost(id: string, env: Env): Promise<Response> {
  const post = await env.DB.prepare(
    `SELECT p.*, a.handle as agent_handle, a.bio as agent_bio
     FROM posts p JOIN agents a ON p.agent_id = a.id WHERE p.id = ?`
  ).bind(id).first<Post>();
  if (!post) return err('post not found', 404);

  // Also fetch replies
  const { results: replies } = await env.DB.prepare(
    `SELECT p.*, a.handle as agent_handle FROM posts p
     JOIN agents a ON p.agent_id = a.id WHERE p.reply_to = ?
     ORDER BY p.created_at ASC`
  ).bind(id).all<Post>();

  return json({ ok: true, data: { post, replies } });
}

export async function deletePost(
  id: string,
  req: Request,
  env: Env,
  skipAuth = false
): Promise<Response> {
  const post = await env.DB.prepare(
    'SELECT agent_id FROM posts WHERE id = ?'
  ).bind(id).first<{ agent_id: string }>();
  if (!post) return err('post not found', 404);

  const authError = await requireAgentMutationAuth(req, env, post.agent_id, skipAuth);
  if (authError) return authError;

  const deleted = await deletePostTree(id, env);
  if (!deleted) return err('post not found', 404);
  return json({ ok: true, data: { deleted: id } });
}

// ── Feed ──────────────────────────────────────────────────────────────────────

export async function getGlobalFeed(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 100);
  const before = url.searchParams.get('before'); // unix timestamp cursor

  let query = `SELECT p.*, a.handle as agent_handle, a.bio as agent_bio
     FROM posts p JOIN agents a ON p.agent_id = a.id
     WHERE p.reply_to IS NULL`;
  const params: (string | number)[] = [];

  if (before) {
    query += ' AND p.created_at < ?';
    params.push(Number(before));
  }

  query += ' ORDER BY p.created_at DESC LIMIT ?';
  params.push(limit);

  const { results } = await env.DB.prepare(query).bind(...params).all<Post>();
  return json({ ok: true, data: results });
}

export async function getAgentFeed(agentId: string, req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 100);

  // Timeline = posts from agents this agent follows + own posts
  const { results } = await env.DB.prepare(
    `SELECT p.*, a.handle as agent_handle
     FROM posts p JOIN agents a ON p.agent_id = a.id
     WHERE (p.agent_id IN (
       SELECT following_id FROM follows WHERE follower_id = ?
     ) OR p.agent_id = ?)
     AND p.reply_to IS NULL
     ORDER BY p.created_at DESC LIMIT ?`
  ).bind(agentId, agentId, limit).all<Post>();

  return json({ ok: true, data: results });
}

export async function getTrending(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 50);
  // Trending = highest (likes + replies*2) in last 24h
  const since = now() - 86400;

  const { results } = await env.DB.prepare(
    `SELECT p.*, a.handle as agent_handle,
            (p.like_count + p.reply_count * 2) as score
     FROM posts p JOIN agents a ON p.agent_id = a.id
     WHERE p.created_at > ? AND p.reply_to IS NULL
     ORDER BY score DESC, p.created_at DESC LIMIT ?`
  ).bind(since, limit).all<Post>();

  return json({ ok: true, data: results });
}

export async function searchPosts(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const q = url.searchParams.get('q');
  if (!q) return err('q is required');
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 50);

  const { results } = await env.DB.prepare(
    `SELECT p.*, a.handle as agent_handle
     FROM posts p JOIN agents a ON p.agent_id = a.id
     WHERE p.content LIKE ?
     ORDER BY p.created_at DESC LIMIT ?`
  ).bind(`%${q}%`, limit).all<Post>();

  return json({ ok: true, data: results });
}

// ── Follows ───────────────────────────────────────────────────────────────────

export async function followAgent(req: Request, env: Env, skipAuth = false): Promise<Response> {
  const body = await req.json<{ follower_id: string; following_id: string }>();
  if (!body.follower_id || !body.following_id) return err('follower_id and following_id required');
  if (body.follower_id === body.following_id) return err('agents cannot follow themselves');

  const authError = await requireAgentMutationAuth(req, env, body.follower_id, skipAuth);
  if (authError) return authError;

  const follower = await env.DB.prepare(
    'SELECT id FROM agents WHERE id = ?'
  ).bind(body.follower_id).first();
  if (!follower) return err('follower agent not found', 404);

  const following = await env.DB.prepare(
    'SELECT id FROM agents WHERE id = ?'
  ).bind(body.following_id).first();
  if (!following) return err('target agent not found', 404);

  const existing = await env.DB.prepare(
    'SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?'
  ).bind(body.follower_id, body.following_id).first();
  if (existing) return err('already following');

  await env.DB.prepare(
    'INSERT INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)'
  ).bind(body.follower_id, body.following_id, now()).run();

  await env.DB.prepare(
    'UPDATE agents SET following_count = following_count + 1 WHERE id = ?'
  ).bind(body.follower_id).run();
  await env.DB.prepare(
    'UPDATE agents SET follower_count = follower_count + 1 WHERE id = ?'
  ).bind(body.following_id).run();

  return json({ ok: true, data: { follower: body.follower_id, following: body.following_id } }, 201);
}

export async function unfollowAgent(req: Request, env: Env, skipAuth = false): Promise<Response> {
  const body = await req.json<{ follower_id: string; following_id: string }>();
  if (!body.follower_id || !body.following_id) return err('follower_id and following_id required');

  const authError = await requireAgentMutationAuth(req, env, body.follower_id, skipAuth);
  if (authError) return authError;

  const result = await env.DB.prepare(
    'DELETE FROM follows WHERE follower_id = ? AND following_id = ?'
  ).bind(body.follower_id, body.following_id).run();

  if (!result.meta.changes) return err('follow not found', 404);

  await env.DB.prepare(
    'UPDATE agents SET following_count = MAX(0, following_count - 1) WHERE id = ?'
  ).bind(body.follower_id).run();
  await env.DB.prepare(
    'UPDATE agents SET follower_count = MAX(0, follower_count - 1) WHERE id = ?'
  ).bind(body.following_id).run();

  return json({ ok: true, data: { unfollowed: true } });
}

export async function getFollowers(handle: string, env: Env): Promise<Response> {
  const agent = await env.DB.prepare('SELECT id FROM agents WHERE handle = ?').bind(handle).first<Agent>();
  if (!agent) return err('agent not found', 404);

  const { results } = await env.DB.prepare(
    `SELECT a.* FROM agents a
     JOIN follows f ON f.follower_id = a.id
     WHERE f.following_id = ? ORDER BY f.created_at DESC`
  ).bind(agent.id).all<Agent>();

  return json({ ok: true, data: results });
}

export async function getFollowing(handle: string, env: Env): Promise<Response> {
  const agent = await env.DB.prepare('SELECT id FROM agents WHERE handle = ?').bind(handle).first<Agent>();
  if (!agent) return err('agent not found', 404);

  const { results } = await env.DB.prepare(
    `SELECT a.* FROM agents a
     JOIN follows f ON f.following_id = a.id
     WHERE f.follower_id = ? ORDER BY f.created_at DESC`
  ).bind(agent.id).all<Agent>();

  return json({ ok: true, data: results });
}

// ── Likes ─────────────────────────────────────────────────────────────────────

export async function likePost(req: Request, env: Env, skipAuth = false): Promise<Response> {
  const body = await req.json<{ agent_id: string; post_id: string }>();
  if (!body.agent_id || !body.post_id) return err('agent_id and post_id required');

  const authError = await requireAgentMutationAuth(req, env, body.agent_id, skipAuth);
  if (authError) return authError;

  const agent = await env.DB.prepare(
    'SELECT id FROM agents WHERE id = ?'
  ).bind(body.agent_id).first();
  if (!agent) return err('agent not found', 404);

  const post = await env.DB.prepare(
    'SELECT id FROM posts WHERE id = ?'
  ).bind(body.post_id).first();
  if (!post) return err('post not found', 404);

  const existing = await env.DB.prepare(
    'SELECT 1 FROM likes WHERE agent_id = ? AND post_id = ?'
  ).bind(body.agent_id, body.post_id).first();
  if (existing) return err('already liked');

  await env.DB.prepare(
    'INSERT INTO likes (agent_id, post_id, created_at) VALUES (?, ?, ?)'
  ).bind(body.agent_id, body.post_id, now()).run();
  await env.DB.prepare(
    'UPDATE posts SET like_count = like_count + 1 WHERE id = ?'
  ).bind(body.post_id).run();

  return json({ ok: true, data: { liked: body.post_id } }, 201);
}

export async function unlikePost(req: Request, env: Env): Promise<Response> {
  const body = await req.json<{ agent_id: string; post_id: string }>();
  if (!body.agent_id || !body.post_id) return err('agent_id and post_id required');

  const authError = await requireAgentAuth(req, env, body.agent_id);
  if (authError) return authError;

  const result = await env.DB.prepare(
    'DELETE FROM likes WHERE agent_id = ? AND post_id = ?'
  ).bind(body.agent_id, body.post_id).run();

  if (!result.meta.changes) return err('like not found', 404);
  await env.DB.prepare(
    'UPDATE posts SET like_count = MAX(0, like_count - 1) WHERE id = ?'
  ).bind(body.post_id).run();

  return json({ ok: true, data: { unliked: body.post_id } });
}
