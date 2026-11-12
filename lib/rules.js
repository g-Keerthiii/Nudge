// Deterministic policy engine. The LLM may PROPOSE terms; only this code decides what is allowed.
export const DEFAULT_RULES = {
  minUpfrontPct: 30,   // if paying in installments, first payment must be at least this % of total
  maxInstallments: 2,  // max number of payments (1 = pay in full)
  maxDaysToPay: 14,    // final payment must land within N days from today
  maxDiscountPct: 0,   // max discount the agent may give
};

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const addDays = (days, from = new Date()) => {
  const d = new Date(from); d.setUTCDate(d.getUTCDate() + Number(days)); return d.toISOString().slice(0, 10);
};

export function sanitizeRules(r = {}) {
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  return {
    minUpfrontPct: num(r.minUpfrontPct, DEFAULT_RULES.minUpfrontPct, 0, 100),
    maxInstallments: Math.round(num(r.maxInstallments, DEFAULT_RULES.maxInstallments, 1, 12)),
    maxDaysToPay: Math.round(num(r.maxDaysToPay, DEFAULT_RULES.maxDaysToPay, 0, 365)),
    maxDiscountPct: num(r.maxDiscountPct, DEFAULT_RULES.maxDiscountPct, 0, 50),
  };
}

// Turns the LLM's proposal into a well-formed offer.
export function normalizeOffer(o = {}, total) {
  const discountPct = Math.max(0, Number(o.discountPct) || 0);
  const discounted = round2(total * (1 - discountPct / 100));
  const installments = Math.max(1, Math.round(Number(o.installments) || 1));
  let upfrontAmount = Number(o.upfrontAmount);
  if (!Number.isFinite(upfrontAmount) || upfrontAmount <= 0) upfrontAmount = installments === 1 ? discounted : round2(discounted * 0.3);
  upfrontAmount = Math.min(round2(upfrontAmount), discounted);
  if (installments === 1) upfrontAmount = discounted;
  const payByDays = Math.max(0, Math.round(Number(o.payByDays) || 0));
  return { upfrontAmount, installments, payByDays, discountPct };
}

export function validateOffer(total, offer, rules) {
  const v = [];
  const o = normalizeOffer(offer, total);
  const discounted = round2(total * (1 - o.discountPct / 100));
  if (o.discountPct > rules.maxDiscountPct) v.push({ code: 'discount', message: `discounts above ${rules.maxDiscountPct}% aren't allowed` });
  if (o.installments > rules.maxInstallments) v.push({ code: 'installments', message: `at most ${rules.maxInstallments} payment${rules.maxInstallments === 1 ? '' : 's'} allowed` });
  if (o.installments > 1 && o.upfrontAmount < round2(discounted * rules.minUpfrontPct / 100) - 0.005)
    v.push({ code: 'upfront', message: `the first payment must be at least ${rules.minUpfrontPct}% (${round2(discounted * rules.minUpfrontPct / 100).toFixed(2)})` });
  if (o.payByDays > rules.maxDaysToPay) v.push({ code: 'days', message: `everything must be paid within ${rules.maxDaysToPay} days` });
  return v;
}

// Closest in-policy offer to what was asked.
export function clampOffer(total, offer, rules) {
  const o = normalizeOffer(offer, total);
  const discountPct = Math.min(o.discountPct, rules.maxDiscountPct);
  const discounted = round2(total * (1 - discountPct / 100));
  const installments = Math.min(o.installments, rules.maxInstallments);
  let upfrontAmount = installments === 1 ? discounted : Math.min(discounted, Math.max(o.upfrontAmount, round2(discounted * rules.minUpfrontPct / 100)));
  return { upfrontAmount: round2(upfrontAmount), installments, payByDays: Math.min(o.payByDays, rules.maxDaysToPay), discountPct };
}

export function buildSchedule(total, offer, from = new Date()) {
  const o = normalizeOffer(offer, total);
  const discounted = round2(total * (1 - o.discountPct / 100));
  if (o.installments === 1) {
    return [{ n: 1, amount: discounted, dueDate: addDays(o.payByDays, from) }];
  }
  const rest = round2(discounted - o.upfrontAmount);
  const count = o.installments - 1;
  const each = round2(rest / count);
  const sched = [{ n: 1, amount: o.upfrontAmount, dueDate: addDays(0, from) }];
  for (let i = 1; i <= count; i++) {
    const amount = i === count ? round2(rest - each * (count - 1)) : each;
    sched.push({ n: i + 1, amount, dueDate: addDays(Math.round((o.payByDays * i) / count), from) });
  }
  return sched;
}

export const money = (n, cur = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(n);

export function describeOffer(total, offer, cur = 'USD', from = new Date()) {
  const s = buildSchedule(total, offer, from);
  if (s.length === 1) return `${money(s[0].amount, cur)} in full by ${s[0].dueDate}`;
  return s.map((p, i) => `${money(p.amount, cur)} ${i === 0 ? 'today' : 'by ' + p.dueDate}`).join(', then ');
}
