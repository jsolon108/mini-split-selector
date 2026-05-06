const SB_URL = 'https://jnhgmnpcwiutkidkadbg.supabase.co';
const SB_KEY = 'sb_publishable_jnXngFrJ8t1eG5sxAcTOUQ_1RJ2KnFV';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { category, message, username, page, device } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message required' });

  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) return res.status(500).json({ error: 'Resend not configured' });

  try {
    // Log to Supabase
    await fetch(`${SB_URL}/rest/v1/feedback`, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ category, message, username, page, device })
    });

    // Send email via Resend
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Ductless Quote Builder <onboarding@resend.dev>',
        to: ['josh.solon@johnstonehvacr.com'],
        subject: `[Feedback] ${category || 'General'} — ${username || 'Unknown user'}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
            <h2 style="color:#185FA5;margin-bottom:4px">Ductless Quote Builder Feedback</h2>
            <hr style="border:1px solid #eee;margin-bottom:20px"/>
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:6px 0;color:#666;width:120px">Category</td><td style="padding:6px 0;font-weight:600">${category || '—'}</td></tr>
              <tr><td style="padding:6px 0;color:#666">From</td><td style="padding:6px 0;font-weight:600">${username || 'Unknown'}</td></tr>
              <tr><td style="padding:6px 0;color:#666">Page</td><td style="padding:6px 0">${page || '—'}</td></tr>
              <tr><td style="padding:6px 0;color:#666">Device</td><td style="padding:6px 0">${device || '—'}</td></tr>
            </table>
            <div style="margin-top:20px;padding:16px;background:#f8f9fa;border-radius:8px;border-left:4px solid #185FA5">
              <div style="color:#666;font-size:12px;margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">Message</div>
              <div style="font-size:15px;line-height:1.6">${message.replace(/\n/g, '<br/>')}</div>
            </div>
          </div>
        `
      })
    });

    if (!emailRes.ok) {
      const err = await emailRes.text();
      console.error('[Feedback] Resend error:', err);
      // Still return success — feedback was logged to Supabase
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[Feedback] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
