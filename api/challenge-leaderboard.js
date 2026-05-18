// ═══════════════════════════════════════════════════════════════════════
// CHALLENGE — LEADERBOARD
// ─────────────────────────────────────────────────────────────────────
// GET /api/challenge-leaderboard?username=...
//
// Returns: {
//   today: {
//     date: "YYYY-MM-DD",
//     standings: [{ rank, username, scenarios_correct, time_seconds, daily_score, time_tier }, ...],
//     your_row: { rank, ... } | null,
//     total_players: number
//   },
//   season: {
//     id, name, start_date, end_date, prize_text,
//     standings: [{ rank, username, total_score, days_played, best_day }, ...],
//     your_row: { ... } | null,
//     total_players: number
//   } | null
// }
// ═══════════════════════════════════════════════════════════════════════

const SB_URL = 'https://jnhgmnpcwiutkidkadbg.supabase.co';
const SB_KEY = 'sb_publishable_jnXngFrJ8t1eG5sxAcTOUQ_1RJ2KnFV';

function todayET() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(new Date());
}

function deriveTier(time, correct) {
  if (correct !== 3) return null;
  if (time < 180) return 'gold';
  if (time < 300) return 'silver';
  if (time < 480) return 'bronze';
  return null;
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    // Parse query params via the WHATWG URL API instead of req.query — avoids the
    // legacy url.parse() fallback in Vercel's runtime that logs a DEP0169 warning.
    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const username = String(reqUrl.searchParams.get('username') || '').trim();
    const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
    const today = todayET();

    // ─── TODAY ───
    const todaysAttempts = await fetchJson(
      `${SB_URL}/rest/v1/challenge_attempts?challenge_date=eq.${today}&select=username,scenarios_correct,time_seconds,daily_score&order=daily_score.desc,time_seconds.asc`,
      headers
    );
    let todayStandings = todaysAttempts.map((a, i) => ({
      rank: i + 1,
      username: a.username,
      scenarios_correct: a.scenarios_correct,
      time_seconds: a.time_seconds,
      daily_score: a.daily_score,
      time_tier: deriveTier(a.time_seconds, a.scenarios_correct),
    }));
    const top10Today = todayStandings; // return all — frontend scrolls
    const yourTodayRow = username
      ? todayStandings.find(r => r.username.toLowerCase() === username.toLowerCase()) || null
      : null;

    // ─── SEASON ───
    let seasonOut = null;
    // First try: active season covering today
    let seasons = await fetchJson(
      `${SB_URL}/rest/v1/challenge_seasons?active=eq.true&start_date=lte.${today}&end_date=gte.${today}&select=*&limit=1`,
      headers
    );
    // Fallback: if today is a trial day with no active season, show the next upcoming season
    // so users still see "May 2026 starts Tuesday" instead of blank.
    let isUpcoming = false;
    if (!seasons.length) {
      const todaysDailyRow = await fetchJson(
        `${SB_URL}/rest/v1/challenges_daily?challenge_date=eq.${today}&select=is_trial`,
        headers
      );
      const todayIsTrial = todaysDailyRow.length > 0 && !!todaysDailyRow[0].is_trial;
      if (todayIsTrial) {
        seasons = await fetchJson(
          `${SB_URL}/rest/v1/challenge_seasons?active=eq.true&start_date=gt.${today}&select=*&order=start_date.asc&limit=1`,
          headers
        );
        isUpcoming = seasons.length > 0;
      }
    }
    if (seasons.length) {
      const season = seasons[0];
      // Get list of trial dates so we can exclude them from season scoring
      const trialRows = await fetchJson(
        `${SB_URL}/rest/v1/challenges_daily?is_trial=eq.true&select=challenge_date`,
        headers
      );
      const trialDates = new Set(trialRows.map(r => r.challenge_date));

      const seasonAttempts = await fetchJson(
        `${SB_URL}/rest/v1/challenge_attempts?challenge_date=gte.${season.start_date}&challenge_date=lte.${season.end_date}&select=username,daily_score,challenge_date,scenarios_correct,time_seconds`,
        headers
      );
      // Aggregate per user, excluding trial days
      const agg = {};
      for (const a of seasonAttempts) {
        if (trialDates.has(a.challenge_date)) continue;
        const u = a.username;
        if (!agg[u]) agg[u] = {
          username: u, total_score: 0, days_played: 0, best_day: 0,
          perfect_days_time_sum: 0, perfect_days_count: 0
        };
        agg[u].total_score += a.daily_score || 0;
        agg[u].days_played += 1;
        if ((a.daily_score || 0) > agg[u].best_day) agg[u].best_day = a.daily_score || 0;
        // Track time on perfect days only (all 3 correct). Used as third tiebreaker.
        if (a.scenarios_correct === 3 && typeof a.time_seconds === 'number') {
          agg[u].perfect_days_time_sum += a.time_seconds;
          agg[u].perfect_days_count += 1;
        }
      }
      // Compute average perfect-day time. Users with no perfect days sort last on this dimension.
      for (const u of Object.values(agg)) {
        u._avg_perfect_time = u.perfect_days_count > 0
          ? u.perfect_days_time_sum / u.perfect_days_count
          : Number.POSITIVE_INFINITY;
      }
      const sorted = Object.values(agg).sort((a, b) => {
        // 1. Higher total_score wins
        if (b.total_score !== a.total_score) return b.total_score - a.total_score;
        // 2. More days_played wins (more committed player)
        if (b.days_played !== a.days_played) return b.days_played - a.days_played;
        // 3. Lower avg time on perfect days wins (faster, but only counted on full clears)
        return a._avg_perfect_time - b._avg_perfect_time;
      });
      // Strip internal-only sort key before returning
      const ranked = sorted.map((r, i) => {
        const { _avg_perfect_time, perfect_days_time_sum, perfect_days_count, ...visible } = r;
        return { rank: i + 1, ...visible };
      });
      const top10Season = ranked; // return all — frontend scrolls
      const yourSeasonRow = username
        ? ranked.find(r => r.username.toLowerCase() === username.toLowerCase()) || null
        : null;

      seasonOut = {
        id: season.id,
        name: season.name,
        start_date: season.start_date,
        end_date: season.end_date,
        prize_text: season.prize_text,
        is_upcoming: isUpcoming,
        standings: top10Season,
        your_row: yourSeasonRow,
        total_players: ranked.length
      };
    }

    return res.status(200).json({
      today: {
        date: today,
        standings: top10Today,
        your_row: yourTodayRow,
        total_players: todayStandings.length
      },
      season: seasonOut
    });
  } catch (err) {
    console.error('[challenge-leaderboard] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
