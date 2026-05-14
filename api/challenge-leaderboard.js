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
  if (time < 300) return 'gold';
  if (time < 480) return 'silver';
  if (time < 720) return 'bronze';
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
    const username = String(req.query.username || '').trim();
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
    const top10Today = todayStandings.slice(0, 10);
    const yourTodayRow = username
      ? todayStandings.find(r => r.username.toLowerCase() === username.toLowerCase()) || null
      : null;

    // ─── SEASON ───
    let seasonOut = null;
    const seasons = await fetchJson(
      `${SB_URL}/rest/v1/challenge_seasons?active=eq.true&start_date=lte.${today}&end_date=gte.${today}&select=*&limit=1`,
      headers
    );
    if (seasons.length) {
      const season = seasons[0];
      const seasonAttempts = await fetchJson(
        `${SB_URL}/rest/v1/challenge_attempts?challenge_date=gte.${season.start_date}&challenge_date=lte.${season.end_date}&select=username,daily_score`,
        headers
      );
      // Aggregate per user
      const agg = {};
      for (const a of seasonAttempts) {
        const u = a.username;
        if (!agg[u]) agg[u] = { username: u, total_score: 0, days_played: 0, best_day: 0 };
        agg[u].total_score += a.daily_score || 0;
        agg[u].days_played += 1;
        if ((a.daily_score || 0) > agg[u].best_day) agg[u].best_day = a.daily_score || 0;
      }
      const sorted = Object.values(agg).sort((a, b) => {
        if (b.total_score !== a.total_score) return b.total_score - a.total_score;
        return b.days_played - a.days_played; // tiebreak: more active player ranks higher
      });
      const ranked = sorted.map((r, i) => ({ rank: i + 1, ...r }));
      const top10Season = ranked.slice(0, 10);
      const yourSeasonRow = username
        ? ranked.find(r => r.username.toLowerCase() === username.toLowerCase()) || null
        : null;

      seasonOut = {
        id: season.id,
        name: season.name,
        start_date: season.start_date,
        end_date: season.end_date,
        prize_text: season.prize_text,
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
