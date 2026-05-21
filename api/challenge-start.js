// ═══════════════════════════════════════════════════════════════════════
// CHALLENGE — START
// ─────────────────────────────────────────────────────────────────────
// POST /api/challenge-start
// Body: { username, challenge_date, scenario_ids: number[] }
//
// Creates an `in_progress` row in challenge_attempts so the user is locked
// into today's attempt. If a row already exists for (username, challenge_date),
// returns 409 with the existing attempt — caller can decide to resume
// (status='in_progress') or block (status='completed').
//
// Returns: {
//   started: boolean,
//   resumed: boolean,
//   attempt: { username, challenge_date, status, started_at, scenario_ids, ... }
// }
// ═══════════════════════════════════════════════════════════════════════

// Service role key — bypasses RLS so the API can manage challenge_attempts even
// though anon writes are blocked. NEVER expose this in the browser. Set the env
// var SUPABASE_SERVICE_ROLE_KEY in your Vercel project settings (Settings →
// Environment Variables) and redeploy. Falls back to the publishable key only
// for local dev safety; production should always have the env var set.
const SB_URL = 'https://jnhgmnpcwiutkidkadbg.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'sb_publishable_jnXngFrJ8t1eG5sxAcTOUQ_1RJ2KnFV';

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${text}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    let { username, challenge_date, scenario_ids } = req.body || {};
    // Normalize username to lowercase for case-insensitive identity. The DB has
    // a unique index on LOWER(username), so 'Foo' and 'foo' collide; we lowercase
    // here so the row is stored in canonical form.
    username = String(username || '').toLowerCase().trim();
    if (!username || !challenge_date) {
      return res.status(400).json({ error: 'username and challenge_date required' });
    }

    const headers = {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json'
    };

    // 1) Check for existing row first — keeps the response shape consistent and
    // gives the caller everything it needs to decide whether to resume.
    const existing = await fetchJson(
      `${SB_URL}/rest/v1/challenge_attempts?username=eq.${encodeURIComponent(username)}&challenge_date=eq.${challenge_date}&select=*&limit=1`,
      { headers }
    );
    if (existing.length) {
      const a = existing[0];
      // Trial mode resumes are handled by the trial-day "play again" branch on the client;
      // here we just report the truth: there's already a row, so refuse to insert a new one.
      return res.status(409).json({
        started: false,
        resumed: a.status === 'in_progress',
        attempt: a,
        error: a.status === 'completed'
          ? 'Already completed today.'
          : 'Attempt already in progress.'
      });
    }

    // 2) No existing row — insert. Use Prefer: return=representation so we get the row back.
    // The unique index on (username, challenge_date) makes this race-safe; if a sibling
    // request beats us, the insert fails with 409 and we fall through to re-fetch.
    let inserted;
    try {
      inserted = await fetchJson(`${SB_URL}/rest/v1/challenge_attempts`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify({
          username,
          challenge_date,
          status: 'in_progress',
          started_at: new Date().toISOString(),
          scenario_ids: Array.isArray(scenario_ids) ? scenario_ids : []
        })
      });
    } catch (e) {
      if (e.status === 409 || e.status === 23505) {
        // Race: another request just inserted. Re-fetch and treat as resume.
        const after = await fetchJson(
          `${SB_URL}/rest/v1/challenge_attempts?username=eq.${encodeURIComponent(username)}&challenge_date=eq.${challenge_date}&select=*&limit=1`,
          { headers }
        );
        return res.status(409).json({
          started: false,
          resumed: after[0]?.status === 'in_progress',
          attempt: after[0] || null,
          error: 'Attempt already in progress.'
        });
      }
      throw e;
    }

    const row = Array.isArray(inserted) ? inserted[0] : inserted;
    return res.status(201).json({ started: true, resumed: false, attempt: row });
  } catch (err) {
    console.error('[challenge-start] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
