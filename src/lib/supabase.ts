import { createClient } from '@supabase/supabase-js';
import type { Env } from '../index';

// Request-scoped client: forwards the caller's JWT so Row-Level Security applies.
// Use this for anything a user is allowed to do as themselves.
export function userClient(env: Env, jwt: string) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });
}

// Service client: BYPASSES RLS. Only for trusted server work — ledger posts,
// webhook handlers, payout runs. Never expose its results raw to a client.
export function serviceClient(env: Env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
}
