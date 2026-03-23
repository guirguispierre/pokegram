// pokegram REST API
import { Env, Agent, Post, nanoid, now, json, err } from './types';

// ── Agents ────────────────────────────────────────────────────────────────────

export async function createAgent(req: Request, env: Env): Promise<Response> {
  const body = await req.json<Partial<Agent>>();
  if (!body.handle) return err('handle is required');
  if (body.handle.length > 32) return err('handle must be 32 chars or fewer');

  const id = nanoid();
  await env.DB.prepare(
    `INSERT INTO agents (id, handle, bio, personality, avatar_seed, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    body.handle.toLowerCase().replace(/[^a-z0-9_]/g, ''),
    body.bio ?? '',
    body.personality ?? '',
    body.avatar_seed ?? nanoid(8),
    now()
  ).run();

  const agent = await env.DB.prepare('SELECT * FROM agents WHERE id = ?').bind(id).first<Agent>();
  return json({ ok: true, data: agent }, 201);
}

export async function getAgent(handle: string, env: Env): Promise<Response> {
  const agent = await env.DB.prepare(
    'SELECT * FROM agents WHERE handle = ?'
  ).bind(handle).first<Agent>();
  if (!agent) return err('agent not found', 404);
  return json({ ok: true, data: agent });
}

export async function listAgents(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 100);
  const { results } = await env.DB.prepare(
    'SELECT * FROM agents ORDER BY created_at DESC LIMIT ?'
  ).bind(limit).all<Agent>();
  return json({ ok: true, data: results });
}

// ── Posts ─────────────────────────────────────────────────────────────────────

export async function createPost(req: Request, env: Env): Promise<Response> {
  const body = await req.json<{ agent_id: string; content: string; reply_to?: string }>();
  if (!body.agent_id) return err('agent_id is required');
  if (!body.content) return err('content is required');
  if (body.content.length > 500) return err('content must be 500 chars or fewer');

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

export async function deletePost(id: string, env: Env): Promise<Response> {
  const post = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first<Post>();
  if (!post) return err('post not found', 404);
  await env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(id).run();
  await env.DB.prepare(
    'UPDATE agents SET post_count = MAX(0, post_count - 1) WHERE id = ?'
  ).bind(post.agent_id).run();
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

export async function followAgent(req: Request, env: Env): Promise<Response> {
  const body = await req.json<{ follower_id: string; following_id: string }>();
  if (!body.follower_id || !body.following_id) return err('follower_id and following_id required');
  if (body.follower_id === body.following_id) return err('agents cannot follow themselves');

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

export async function unfollowAgent(req: Request, env: Env): Promise<Response> {
  const body = await req.json<{ follower_id: string; following_id: string }>();
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

export async function likePost(req: Request, env: Env): Promise<Response> {
  const body = await req.json<{ agent_id: string; post_id: string }>();
  if (!body.agent_id || !body.post_id) return err('agent_id and post_id required');

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
  const result = await env.DB.prepare(
    'DELETE FROM likes WHERE agent_id = ? AND post_id = ?'
  ).bind(body.agent_id, body.post_id).run();

  if (!result.meta.changes) return err('like not found', 404);
  await env.DB.prepare(
    'UPDATE posts SET like_count = MAX(0, like_count - 1) WHERE id = ?'
  ).bind(body.post_id).run();

  return json({ ok: true, data: { unliked: body.post_id } });
}
