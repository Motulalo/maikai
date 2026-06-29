import { Hono } from 'hono';
import type { Env } from '../index';
import { userClient } from '../lib/supabase';

// All routes run under the caller's JWT → RLS scopes everything to this merchant.
const merchant = new Hono<{ Bindings: Env }>();
const db = (c: any) => userClient(c.env, c.req.header('Authorization').slice(7));

// Accept an incoming order with a prep ETA.
merchant.post('/orders/:id/accept', async (c) => {
  const { prepMin } = await c.req.json();
  const { error } = await db(c).from('orders').update({ status: 'preparing' }).eq('id', c.req.param('id'));
  if (error) return c.json({ error: error.message }, 403);
  await db(c).from('order_events').insert({ order_id: c.req.param('id'), type: 'accepted', actor: 'merchant', meta: { prepMin } });
  return c.json({ ok: true });
});

merchant.post('/orders/:id/ready', async (c) => {
  await db(c).from('orders').update({ status: 'ready' }).eq('id', c.req.param('id'));
  return c.json({ ok: true });
});

merchant.patch('/menu/:id', async (c) => {
  const { available } = await c.req.json();
  const { error } = await db(c).from('menu_items').update({ available }).eq('id', c.req.param('id'));
  return error ? c.json({ error: error.message }, 403) : c.json({ ok: true });
});

// Create a promotion (merchant-funded / co-funded / sponsored ad).
merchant.post('/promotions', async (c) => {
  const b = await c.req.json(); // { merchantId, promoType, valueNum, funding, budgetCents, sponsored }
  const { data, error } = await db(c).from('promotions').insert(b).select().single();
  return error ? c.json({ error: error.message }, 403) : c.json(data);
});

merchant.patch('/promotions/:id', async (c) => {
  const { status } = await c.req.json();
  await db(c).from('promotions').update({ status }).eq('id', c.req.param('id'));
  return c.json({ ok: true });
});

merchant.post('/reviews/:id/reply', async (c) => {
  const { reply } = await c.req.json();
  await db(c).from('reviews').update({ reply, replied_at: new Date().toISOString() }).eq('id', c.req.param('id'));
  return c.json({ ok: true });
});

export default merchant;
