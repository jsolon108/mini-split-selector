// ═══════════════════════════════════════════════════════════════════════
// CHALLENGE — ADMIN RESET
// ─────────────────────────────────────────────────────────────────────
// POST /api/challenge-admin-reset
// Body: { admin_username, target_username, challenge_date }
//
// Deletes a user's attempt row for a given date. Replaces the direct
// client-side DELETE that previously hit Supabase from the browser (which
// only worked because RLS was off — anyone could call it).
//
// Auth model: verifies admin_username is in the admin_users table. Lightweight,
// matches the rest of this tool's admin pattern. If you adopt real auth later,
// swap this check for a session/JWT check.
// ═══════════════════════════════════════════════════════════════════════

const SB_URL = 'https://jnhgmnpcwiutkidkadbg.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'sb_publishable_jnXngFrJ8t1eG5sxAcTOUQ_1RJ2KnFV';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    let { admin_username, target_username, challenge_date } = req.body || {};
    // Normalize to lowercase to match the canonical username form in the DB.
    admin_username = String(admin_username || '').toLowerCase().trim();
    target_username = String(target_username || '').toLowerCase().trim();
    if (!admin_username || !target_username || !challenge_date) {
      return res.status(400).json({ error: 'admin_username, target_username, challenge_date required' });
    }

    const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

    // Verify admin: must exist in admin_users. Case-insensitive match to mirror
    // the client-side isAdmin() check (which lowercases both sides).
    const adminCheck = await fetch(
      `${SB_URL}/rest/v1/admin_users?username=eq.${encodeURIComponent(admin_username)}&select=username&limit=1`,
      { headers }
    );
    const adminRows = await adminCheck.json();
    if (!adminRows.length) {
      return res.status(403).json({ error: 'Not authorized.' });
    }

    // Delete the target's attempt for that date
    const delRes = await fetch(
      `${SB_URL}/rest/v1/challenge_attempts?username=eq.${encodeURIComponent(target_username)}&challenge_date=eq.${challenge_date}`,
      { method: 'DELETE', headers: { ...headers, 'Prefer': 'return=minimal' } }
    );
    if (!delRes.ok) {
      const text = await delRes.text();
      return res.status(500).json({ error: 'Reset failed', detail: text });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[challenge-admin-reset] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
