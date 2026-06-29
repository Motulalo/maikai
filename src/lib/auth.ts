import { Hono } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from '../index';

// Verifies the Supabase JWT (HS256 with SUPABASE_JWT_SECRET) and stashes claims.
export async function requireAuth(c: any, next: any) {
  const auth = c.req.header('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return c.json({ error: 'unauthorized' }, 401);
  try {
    const secret = new TextEncoder().encode(c.env.SUPABASE_JWT_SECRET);
    const { payload } = await jwtVerify(token, secret);
    c.set('userId', payload.sub);
    c.set('role', (payload as any).app_metadata?.role ?? 'customer');
    c.set('claims', payload);
    await next();
  } catch {
    return c.json({ error: 'invalid token' }, 401);
  }
}

// Wraps a sub-router so only one role may reach it. Defense-in-depth ON TOP of RLS,
// never instead of it — the database is the final authority.
export function requireRole(role: string, router: Hono<{ Bindings: Env }>) {
  const guard = new Hono<{ Bindings: Env }>();
  guard.use('*', async (c, next) => {
    if (c.get('role') !== role && c.get('role') !== 'operator') {
      return c.json({ error: 'forbidden' }, 403);
    }
    await next();
  });
  guard.route('/', router);
  return guard;
}
