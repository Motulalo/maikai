import type { Env } from '../index';
import { serviceClient } from '../lib/supabase';

// Cron 03:00 daily — net each merchant's sales minus commission & courier fees,
// write a payouts row, and instruct disbursement via BSP. Ledger is the source of truth.
export async function runPayouts(env: Env) {
  const db = serviceClient(env);
  const period = isoWeek(new Date());
  const { data: merchants } = await db.from('merchants').select('id, commission_pct').eq('active', true);
  for (const m of merchants ?? []) {
    // sum settled order credits for this merchant in the period from ledger_entries
    const net = await netForMerchant(db, m.id, period); // cents, after commission + courier fees
    if (net <= 0) continue;
    await db.from('payouts').insert({ merchant_id: m.id, period, net_cents: net, status: 'pending' });
    // TODO: call BSP disbursement API, then mark status: 'sent', sent_at: now()
  }
}

// Cron */15 — decrement promo budgets from redemptions/ad_charges; auto-pause at budget.
export async function syncBudgets(env: Env) {
  const db = serviceClient(env);
  const { data: promos } = await db.from('promotions').select('id, budget_cents, spent_cents').eq('status', 'active');
  for (const p of promos ?? []) {
    if (p.spent_cents >= p.budget_cents && p.budget_cents > 0) {
      await db.from('promotions').update({ status: 'paused' }).eq('id', p.id);
    }
  }
}

// Cron */15 — surface chargebacks nearing their network deadline to the operator queue.
export async function scanChargebackDeadlines(env: Env) {
  const db = serviceClient(env);
  const soon = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  await db.from('chargebacks').select('id').eq('state', 'open').lte('deadline', soon);
  // TODO: emit operator alert / notification for each
}

async function netForMerchant(db: any, merchantId: string, period: string): Promise<number> {
  // SELECT sum(credit) - sum(debit) FROM ledger_entries WHERE account = 'merchant:<id>' AND period
  return 0; // TODO
}
function isoWeek(d: Date): string {
  const onejan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil((((d.getTime() - onejan.getTime()) / 86400000) + onejan.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}
