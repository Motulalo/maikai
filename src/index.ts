import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { requireAuth, requireRole } from './lib/auth';
import orders from './routes/orders';
import payments from './routes/payments';
import merchant from './routes/merchant';
import operator from './routes/operator';

export interface Env {
  ORDER_ROOM: DurableObjectNamespace;
  MEDIA: R2Bucket;
  KYC_DOCS: R2Bucket;
  JOBS: Queue;
  RATE: KVNamespace;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  SUPABASE_JWT_SECRET: string;
  DOKU_CLIENT_ID: string;
  DOKU_SECRET: string;
  DOKU_WEBHOOK_SECRET: string;
  BSP_SETTLEMENT_SECRET: string;
  GOOGLE_MAPS_KEY: string;
  TURNSTILE_SECRET: string;
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({ origin: ['https://maikai.app', 'http://localhost:5173'], credentials: true }));

// Webhooks are signature-verified inside the handler — NOT behind user auth.
app.route('/hooks', payments); // exposes /hooks/doku/*, /hooks/bsp/*

// Everything else requires a valid Supabase JWT.
app.use('/api/*', requireAuth);
app.route('/api/orders', orders);
app.route('/api/merchant', requireRole('merchant', merchant));
app.route('/api/admin', requireRole('operator', operator));

app.get('/health', (c) => c.json({ ok: true, service: 'maikai-api' }));

export default app;
export { OrderRoom } from './do/OrderRoom';

// Cron entry — payout runs (03:00) + budget/deadline scans (*/15).
export async function scheduled(event: ScheduledController, env: Env) {
  const { runPayouts, syncBudgets, scanChargebackDeadlines } = await import('./jobs/payout-run');
  if (event.cron === '0 3 * * *') await runPayouts(env);
  else { await syncBudgets(env); await scanChargebackDeadlines(env); }
}
