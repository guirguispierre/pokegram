import { Env, err, nanoid, now } from './types';

interface AgentApiKeyRecord {
  agent_id: string;
  key_hash: string;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function hashApiKey(apiKey: string): Promise<string> {
  const data = new TextEncoder().encode(apiKey);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(digest);
}

export function generateAgentApiKey(): string {
  return `pg_${nanoid(42)}`;
}

export async function issueAgentApiKey(env: Env, agentId: string): Promise<string> {
  const apiKey = generateAgentApiKey();
  const keyHash = await hashApiKey(apiKey);
  const ts = now();

  const existing = await env.DB.prepare(
    'SELECT agent_id FROM agent_api_keys WHERE agent_id = ?'
  ).bind(agentId).first();

  if (existing) {
    await env.DB.prepare(
      'UPDATE agent_api_keys SET key_hash = ?, rotated_at = ?, last_used_at = NULL WHERE agent_id = ?'
    ).bind(keyHash, ts, agentId).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO agent_api_keys (agent_id, key_hash, created_at, rotated_at, last_used_at)
       VALUES (?, ?, ?, ?, NULL)`
    ).bind(agentId, keyHash, ts, ts).run();
  }

  return apiKey;
}

export async function deleteAgentApiKey(env: Env, agentId: string): Promise<void> {
  await env.DB.prepare(
    'DELETE FROM agent_api_keys WHERE agent_id = ?'
  ).bind(agentId).run();
}

export function extractApiKey(req: Request): string | null {
  const authHeader = req.headers.get('authorization');
  if (authHeader?.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }

  const headerApiKey = req.headers.get('x-agent-api-key');
  if (headerApiKey?.trim()) return headerApiKey.trim();

  return null;
}

export async function requireAgentAuth(
  req: Request,
  env: Env,
  agentId: string
): Promise<Response | null> {
  const apiKey = extractApiKey(req);
  if (!apiKey) {
    return err('missing agent api key', 401);
  }

  const record = await env.DB.prepare(
    'SELECT agent_id, key_hash FROM agent_api_keys WHERE agent_id = ?'
  ).bind(agentId).first<AgentApiKeyRecord>();

  if (!record) {
    return err('agent api key not configured for this account', 401);
  }

  const providedHash = await hashApiKey(apiKey);
  if (providedHash !== record.key_hash) {
    return err('invalid agent api key', 403);
  }

  await env.DB.prepare(
    'UPDATE agent_api_keys SET last_used_at = ? WHERE agent_id = ?'
  ).bind(now(), agentId).run();

  return null;
}
