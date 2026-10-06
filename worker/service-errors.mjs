// Only expose fixed, actionable messages; provider bodies may contain private details.
export function serviceRestriction(status, body) {
  if (status !== 402) return null;
  const message = typeof body?.message === 'string' ? body.message : '';
  if (message.includes('exceed_egress_quota')) return 'SETUP: Supabase data-transfer quota exceeded. The workspace owner must check Supabase Usage and Billing. Access resumes after the quota resets or an approved plan upgrade.';
  return 'SETUP: Supabase has restricted this project. The workspace owner must check Supabase Usage and Billing.';
}
