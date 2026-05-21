// ═══════════════════════════════════════════════════════════════════════
// CHALLENGE — PROGRESS
// ─────────────────────────────────────────────────────────────────────
// POST /api/challenge-progress
// Body: {
//   username, challenge_date,
//   scenario_idx: number,          // next scenario the user should see (0-2 normally, 3 = ready to submit)
//   submissions:  [{ scenario_id, quote }, ...]   // cumulative, ungraded
// }
//
// PATCHes the in_progress challenge_attempts row so that refreshing the page
// resumes the user at the correct scenario with their previous submissions intact.
//
// Refuses if the row is already `completed` (no clobbering a final score).
// ═══════════════════════════════════════════════════════════════════════

// Service role key — bypasses RLS so the API can manage challenge_attempts even
// though anon writes are blocked. NEVER expose this in the browser. Set the env
// var SUPABASE_SERVICE_ROLE_KEY in your Vercel project settings (Settings →
// Environment Variables) and redeploy. Falls back to the publishable key only
// for local dev safety; production should always have the env var set.
const SB_URL = 'https://jnhgmnpcwiutkidkadbg.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'sb_publishable_jnXngFrJ8t1eG5sxAcTOUQ_1RJ2KnFV';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    let { username, challenge_date, scenario_idx, submissions } = req.body || {};
    // Normalize username to lowercase (matches the canonical form in the DB).
    username = String(username || '').toLowerCase().trim();
    if (!username || !challenge_date) {
      return res.status(400).json({ error: 'username and challenge_date required' });
    }
    if (typeof scenario_idx !== 'number' || !Array.isArray(submissions)) {
      return res.status(400).json({ error: 'scenario_idx (number) and submissions (array) required' });
    }

    const headers = {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json'
    };

    // Look up the attempt row first so we can refuse to overwrite a completed one.
    const lookupRes = await fetch(
      `${SB_URL}/rest/v1/challenge_attempts?username=eq.${encodeURIComponent(username)}&challenge_date=eq.${challenge_date}&select=id,status&limit=1`,
      { headers }
    );
    const lookupRows = await lookupRes.json();
    const row = lookupRows[0];
    if (!row) {
      // No in_progress row to update — usually means the client didn't call /api/challenge-start.
      // Fail closed: don't auto-create here, because that would skip the unique-key lockout.
      return res.status(404).json({ error: 'No in-progress attempt to update.' });
    }
    if (row.status === 'completed') {
      return res.status(409).json({ error: 'Attempt is already completed; cannot update progress.' });
    }

    // PATCH the row with the new progress snapshot.
    const patchRes = await fetch(
      `${SB_URL}/rest/v1/challenge_attempts?username=eq.${encodeURIComponent(username)}&challenge_date=eq.${challenge_date}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          scenario_idx,
          submissions
        })
      }
    );
    if (!patchRes.ok) {
      const text = await patchRes.text();
      return res.status(500).json({ error: 'Progress write failed', detail: text });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[challenge-progress] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
