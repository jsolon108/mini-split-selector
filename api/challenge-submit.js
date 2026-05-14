// ═══════════════════════════════════════════════════════════════════════
// CHALLENGE — SUBMIT
// ─────────────────────────────────────────────────────────────────────
// POST /api/challenge-submit
// Body: {
//   username: string,
//   challenge_date: "YYYY-MM-DD",  // must match server's today
//   started_at: ISO timestamp,
//   submissions: [
//     { scenario_id: number, quote: { zones, common, lineHide, customItems } },
//     { scenario_id, quote },
//     { scenario_id, quote },
//   ]
// }
//
// Returns: {
//   attempt: { ... full row from challenge_attempts ... },
//   scenario_results: [{ scenario_id, name, passed, fail_reasons, score_breakdown }, ...],
//   daily_score, time_seconds, time_tier ("gold"|"silver"|"bronze"|null)
// }
//
// Scoring (tier D):
//   - Each scenario passed: 100 pts
//   - All 3 passed (perfect): +50 pts
//   - Time bonuses (only awarded if all 3 passed):
//       under  5 min: +100 (gold)
//       under  8 min: +50  (silver)
//       under 12 min: +25  (bronze)
//   - Max daily: 100+100+100 + 50 + 100 = 450
//
// Enforces one-attempt-per-day via UNIQUE (username, challenge_date) on challenge_attempts.
// ═══════════════════════════════════════════════════════════════════════

import { gradeQuote } from './challenge-grade.js';

const SB_URL = 'https://jnhgmnpcwiutkidkadbg.supabase.co';
const SB_KEY = 'sb_publishable_jnXngFrJ8t1eG5sxAcTOUQ_1RJ2KnFV';

function todayET() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(new Date());
}

async function fetchLookups(headers) {
  const [commonRes, lineHideRes] = await Promise.all([
    fetch(`${SB_URL}/rest/v1/common_addons?active=eq.true&select=sku,mfg_num,description`, { headers }),
    fetch(`${SB_URL}/rest/v1/line_hide_products?active=eq.true&select=order_num,mfg_num,description,size_str,color`, { headers }),
  ]);
  const commonRows = await commonRes.json();
  const lineHideRows = await lineHideRes.json();
  const commonBySku = {};
  for (const r of commonRows) commonBySku[r.sku] = r;
  const lineHideByOrder = {};
  for (const r of lineHideRows) lineHideByOrder[r.order_num] = r;
  return { commonBySku, lineHideByOrder };
}

function scoreBreakdown(scenarioResults, timeSeconds) {
  const passedCount = scenarioResults.filter(r => r.passed).length;
  const perScenario = passedCount * 100;
  const perfect = passedCount === 3 ? 50 : 0;
  // Time bonuses only if all 3 passed
  let timeBonus = 0;
  let tier = null;
  if (passedCount === 3) {
    if (timeSeconds < 300) { timeBonus = 100; tier = 'gold'; }
    else if (timeSeconds < 480) { timeBonus = 50; tier = 'silver'; }
    else if (timeSeconds < 720) { timeBonus = 25; tier = 'bronze'; }
  }
  return {
    per_scenario: perScenario,
    perfect_bonus: perfect,
    time_bonus: timeBonus,
    time_tier: tier,
    total: perScenario + perfect + timeBonus
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { username, challenge_date, started_at, submissions, user_branch } = req.body || {};
    if (!username || !challenge_date || !started_at || !Array.isArray(submissions)) {
      return res.status(400).json({ error: 'username, challenge_date, started_at, submissions required' });
    }
    if (submissions.length !== 3) {
      return res.status(400).json({ error: 'exactly 3 submissions required' });
    }
    if (challenge_date !== todayET()) {
      return res.status(400).json({ error: `challenge_date mismatch (server today is ${todayET()})` });
    }

    const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

    // Hard guard: has this user already attempted today?
    const existing = await fetch(
      `${SB_URL}/rest/v1/challenge_attempts?username=eq.${encodeURIComponent(username)}&challenge_date=eq.${challenge_date}&select=id`,
      { headers }
    ).then(r => r.json());
    if (existing.length) {
      return res.status(409).json({ error: 'Already attempted today', attempt_id: existing[0].id });
    }

    // Verify the scenarios match today's daily row (rep can't substitute their own)
    const dailyRow = await fetch(
      `${SB_URL}/rest/v1/challenges_daily?challenge_date=eq.${challenge_date}&select=scenario_ids`,
      { headers }
    ).then(r => r.json());
    if (!dailyRow.length) return res.status(400).json({ error: 'No challenge for today yet — please fetch /api/challenge-today first' });
    const allowedIds = new Set(dailyRow[0].scenario_ids || []);
    for (const sub of submissions) {
      if (!allowedIds.has(sub.scenario_id)) {
        return res.status(400).json({ error: `scenario_id ${sub.scenario_id} is not in today's challenge` });
      }
    }

    // Fetch the full scenario specs
    const idsCsv = submissions.map(s => s.scenario_id).join(',');
    const scenarios = await fetch(
      `${SB_URL}/rest/v1/challenge_scenarios?id=in.(${idsCsv})&select=id,name,spec`,
      { headers }
    ).then(r => r.json());
    const scenarioById = Object.fromEntries(scenarios.map(s => [s.id, s]));

    // Lookups for the grader
    const lookups = await fetchLookups(headers);

    // Grade each submission
    const scenarioResults = submissions.map(sub => {
      const scenario = scenarioById[sub.scenario_id];
      if (!scenario) return { scenario_id: sub.scenario_id, name: '(unknown)', passed: false, fail_reasons: ['Scenario not found'] };
      const result = gradeQuote(sub.quote || { zones: [] }, scenario, lookups);
      return {
        scenario_id: scenario.id,
        name: scenario.name,
        passed: result.passed,
        fail_reasons: result.fail_reasons || []
      };
    });

    // Calculate time and score
    const startMs = Date.parse(started_at);
    const nowMs = Date.now();
    let timeSeconds = Math.max(1, Math.round((nowMs - startMs) / 1000));
    // Cap at 1 hour to prevent absurd values from clock drift
    if (timeSeconds > 3600) timeSeconds = 3600;

    const breakdown = scoreBreakdown(scenarioResults, timeSeconds);
    const passedCount = scenarioResults.filter(r => r.passed).length;

    // Write the attempt row
    const attemptInsert = await fetch(`${SB_URL}/rest/v1/challenge_attempts`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({
        username,
        challenge_date,
        started_at,
        completed_at: new Date().toISOString(),
        scenario_results: scenarioResults,
        scenarios_correct: passedCount,
        time_seconds: timeSeconds,
        daily_score: breakdown.total,
        user_branch: user_branch || null
      })
    });
    if (!attemptInsert.ok) {
      const errText = await attemptInsert.text();
      // Likely a unique constraint race — surface gracefully
      return res.status(409).json({ error: 'Attempt write failed (probably already attempted today)', detail: errText });
    }
    const attemptRows = await attemptInsert.json();
    const attempt = attemptRows[0];

    return res.status(200).json({
      attempt,
      scenario_results: scenarioResults,
      daily_score: breakdown.total,
      time_seconds: timeSeconds,
      time_tier: breakdown.time_tier,
      score_breakdown: breakdown
    });
  } catch (err) {
    console.error('[challenge-submit] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
