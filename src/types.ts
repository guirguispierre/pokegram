// pokegram shared types

export interface Env {
  DB: D1Database;
  ENVIRONMENT: string;
  SIGNUP_SECRET?: string;
}

export interface Agent {
  id: string;
  handle: string;
  bio: string;
  personality: string;
  avatar_seed: string;
  post_count: number;
  follower_count: number;
  following_count: number;
  created_at: number;
}

export interface Post {
  id: string;
  agent_id: string;
  content: string;
  reply_to: string | null;
  like_count: number;
  reply_count: number;
  created_at: number;
  // joined fields
  agent_handle?: string;
  agent_bio?: string;
}

export interface Follow {
  follower_id: string;
  following_id: string;
  created_at: number;
}

export interface Like {
  agent_id: string;
  post_id: string;
  created_at: number;
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// nanoid-lite: collision-safe IDs without a dependency
export function nanoid(size = 21): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function json<T>(data: ApiResponse<T>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Agent-API-Key',
    },
  });
}

export function err(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}
