// ═══════════════════════════════════════════════════════════════════════
// CHALLENGE — TODAY
// ─────────────────────────────────────────────────────────────────────
// GET /api/challenge-today?username=...
//
// Returns: {
//   challenge_date: "YYYY-MM-DD",
//   scenarios: [{ id, name, customer_blurb, difficulty }, ...] (3 items, NO spec)
//   already_attempted: boolean   // true only for COMPLETED attempts (gates the start UI)
//   in_progress: boolean         // true if user has a started-but-not-submitted row
//   attempt: { ... } | null      // the row (completed OR in_progress)
//   season: { id, name, start_date, end_date, prize_text } | null
// }
//
// Lazily picks 3 scenarios on the first call of the day, writes to challenges_daily.
// All subsequent calls return the same 3 for that calendar date (in ET).
// ═══════════════════════════════════════════════════════════════════════

// Service role key — bypasses RLS so the API can manage challenge_attempts even
// though anon writes are blocked. NEVER expose this in the browser. Set the env
// var SUPABASE_SERVICE_ROLE_KEY in your Vercel project settings (Settings →
// Environment Variables) and redeploy. Falls back to the publishable key only
// for local dev safety; production should always have the env var set.
const SB_URL = 'https://jnhgmnpcwiutkidkadbg.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'sb_publishable_jnXngFrJ8t1eG5sxAcTOUQ_1RJ2KnFV';

function todayET() {
  // Return YYYY-MM-DD in America/New_York. Server is UTC, so we shift.
  const d = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(d); // en-CA yields YYYY-MM-DD
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

async function getOrCreateDailyChallenge(challengeDate, headers) {
  // 1) Does today's challenge row already exist?
  const existing = await fetchJson(
    `${SB_URL}/rest/v1/challenges_daily?challenge_date=eq.${challengeDate}&select=challenge_date,scenario_ids,is_trial`,
    { headers }
  );
  if (existing.length) return existing[0];

  // 2) Pick 3 scenarios. Avoid scenarios used in the last 5 days so we get variety.
  //    Pull all active scenario IDs, then filter out recent ones, then shuffle and take 3.
  const allScenarios = await fetchJson(
    `${SB_URL}/rest/v1/challenge_scenarios?active=eq.true&select=id`,
    { headers }
  );
  const allIds = allScenarios.map(r => r.id);

  // Recently used IDs from the last 5 daily rows
  const recent = await fetchJson(
    `${SB_URL}/rest/v1/challenges_daily?select=scenario_ids&order=challenge_date.desc&limit=5`,
    { headers }
  );
  const recentIds = new Set();
  for (const row of recent) {
    for (const id of (row.scenario_ids || [])) recentIds.add(id);
  }

  let candidates = allIds.filter(id => !recentIds.has(id));
  // Fallback: if we've burned through everything, just use the full pool
  if (candidates.length < 3) candidates = allIds;

  // Fisher-Yates shuffle, take 3
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const picked = candidates.slice(0, 3).sort((a, b) => a - b);

  // 3) Try to insert. On race (two reps hit this simultaneously), the unique PK
  //    on challenge_date will reject one — re-fetch and use the winner's row.
  try {
    await fetch(`${SB_URL}/rest/v1/challenges_daily`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ challenge_date: challengeDate, scenario_ids: picked })
    });
  } catch (e) {
    // ignore — refetch below
  }
  const after = await fetchJson(
    `${SB_URL}/rest/v1/challenges_daily?challenge_date=eq.${challengeDate}&select=challenge_date,scenario_ids,is_trial`,
    { headers }
  );
  return after[0] || { challenge_date: challengeDate, scenario_ids: picked, is_trial: false };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    // Parse query params via the WHATWG URL API instead of req.query.
    // Touching req.query makes Vercel's runtime fall back to the legacy url.parse(),
    // which logs a DEP0169 deprecation warning on current Node versions.
    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    // Normalize to lowercase so the attempt lookup matches the canonical form in the DB.
    const username = String(reqUrl.searchParams.get('username') || '').trim().toLowerCase();
    if (!username) return res.status(400).json({ error: 'username required' });

    const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
    const challengeDate = todayET();

    // Get or create today's challenge row
    const daily = await getOrCreateDailyChallenge(challengeDate, headers);
    const scenarioIds = daily.scenario_ids || [];

    // Fetch scenario presentation data (no spec — graders apply the spec internally on submit)
    const idsCsv = scenarioIds.join(',');
    const scenarios = scenarioIds.length
      ? await fetchJson(
          `${SB_URL}/rest/v1/challenge_scenarios?id=in.(${idsCsv})&select=id,name,customer_blurb,difficulty`,
          { headers }
        )
      : [];
    // Order to match scenario_ids order
    const byId = Object.fromEntries(scenarios.map(s => [s.id, s]));
    const orderedScenarios = scenarioIds.map(id => byId[id]).filter(Boolean);

    // Has this user already attempted today? Look up ANY status (completed or in_progress).
    // We expose `already_attempted` (legacy meaning = completed only) AND `in_progress`
    // so the client can decide whether to show results or resume the run.
    const attemptRows = await fetchJson(
      `${SB_URL}/rest/v1/challenge_attempts?username=eq.${encodeURIComponent(username)}&challenge_date=eq.${challengeDate}&select=*&order=completed_at.desc.nullslast&limit=1`,
      { headers }
    );
    const attempt = attemptRows[0] || null;
    const isCompleted = !!attempt && attempt.status === 'completed';
    const isInProgress = !!attempt && attempt.status === 'in_progress';

    // Pull active season (if any)
    const seasonRows = await fetchJson(
      `${SB_URL}/rest/v1/challenge_seasons?active=eq.true&start_date=lte.${challengeDate}&end_date=gte.${challengeDate}&select=id,name,start_date,end_date,prize_text&limit=1`,
      { headers }
    );

    return res.status(200).json({
      challenge_date: challengeDate,
      is_trial: !!daily.is_trial,
      scenarios: orderedScenarios,
      already_attempted: isCompleted,
      in_progress: isInProgress,
      attempt,
      season: seasonRows[0] || null
    });
  } catch (err) {
    console.error('[challenge-today] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
