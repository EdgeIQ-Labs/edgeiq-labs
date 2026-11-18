/**
 * PhishSim ROI Dashboard API
 * GET /api/phishsim/roi?cid=X   (or X-Customer-ID header)
 *
 * Aggregates GoPhish campaign results + training completion into ROI metrics.
 *
 * Data path notes (verified against phishsim-manager/server.py):
 * - Manager proxy route is /proxy/<cid>/<path> and it PREPENDS /api/ itself,
 *   so paths here must NOT start with /api/ (use 'campaigns/', not '/api/campaigns/').
 * - GoPhish GET /api/campaigns/ returns summaries WITHOUT per-recipient results;
 *   results come from GET /api/campaigns/<id> (see catchall handleCampaigns).
 * - Training assignments live in PULSE_KV as training:assignments:<email>
 *   (written by /api/training/assign). No roster key is written for PhishSim
 *   customers, so the user set is derived from campaign recipients.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Customer-ID',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// Same URL shape as the catchall's gophishProxy helper.
async function gophishGet(env, customerId, path) {
  const url = `${env.PHISHSIM_MGR_URL}/proxy/${customerId}/${path}`;
  try {
    const resp = await fetch(url, {
      headers: {
        'X-Provision-Secret': env.PHISHSIM_SECRET,
        'Content-Type': 'application/json',
      },
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const url = new URL(request.url);
  const customerId = url.searchParams.get('cid') || request.headers.get('X-Customer-ID');
  if (!customerId) {
    return json({ error: 'Missing customer ID' }, 400);
  }

  // Verify customer exists in KV — same key format as the catchall proxy
  const instanceRaw = await env.PHISHSIM_KV.get(`instance:${customerId}`);
  if (!instanceRaw) {
    return json({ error: 'Invalid customer ID' }, 404);
  }

  try {
    // 1) Campaign list (summaries only)
    let campaigns = await gophishGet(env, customerId, 'campaigns/');
    if (!Array.isArray(campaigns)) campaigns = [];

    // Newest first; cap detail fetches to keep subrequest count bounded
    campaigns.sort((a, b) => (b.launch_date || '').localeCompare(a.launch_date || ''));
    const recent = campaigns.slice(0, 12);

    // 2) Per-campaign recipient results (parallel)
    const details = await Promise.all(
      recent.map(c => gophishGet(env, customerId, `campaigns/${c.id}`))
    );

    const campaignStats = [];
    const emails = new Set();
    let totalSent = 0, totalOpened = 0, totalClicked = 0, totalSubmitted = 0;

    for (let i = 0; i < recent.length; i++) {
      const c = recent[i];
      const d = details[i] || {};
      const results = Array.isArray(d.results) ? d.results : [];
      const launchDate = (d.launch_date || c.launch_date || '').substring(0, 10) || 'unknown';

      let sent = 0, opened = 0, clicked = 0, submitted = 0;
      for (const r of results) {
        if (r.email) emails.add(String(r.email).toLowerCase());
        const st = r.status || '';
        // GoPhish terminal statuses: Email Sent < Email Opened < Clicked Link < Submitted Data
        if (st && st !== 'Sending' && st !== 'Error') sent++;
        if (st === 'Email Opened' || st === 'Clicked Link' || st === 'Submitted Data') opened++;
        if (st === 'Clicked Link' || st === 'Submitted Data') clicked++;
        if (st === 'Submitted Data') submitted++;
      }

      totalSent += sent;
      totalOpened += opened;
      totalClicked += clicked;
      totalSubmitted += submitted;

      campaignStats.push({
        id: c.id,
        name: d.name || c.name || `Campaign ${c.id}`,
        date: launchDate,
        sent,
        opened,
        clicked,
        submitted,
        click_rate: sent > 0 ? Math.round((clicked / sent) * 100) : 0,
        submit_rate: sent > 0 ? Math.round((submitted / sent) * 100) : 0,
      });
    }

    // 3) Training completion for known recipients (cap KV reads at 100 users)
    const userList = [...emails].slice(0, 100);
    const trainingRows = await Promise.all(userList.map(async (email) => {
      const assignments = (await env.PULSE_KV.get(`training:assignments:${email}`, 'json')) || [];
      const progress = (await env.PULSE_KV.get(`training:progress:${email}`, 'json')) || {};
      const assigned = Array.isArray(assignments) ? assignments.length : 0;
      const completed = Array.isArray(assignments)
        ? assignments.filter(a => progress[a.scenario]).length
        : 0;
      return { email, assigned, completed };
    }));

    let totalAssigned = 0, totalCompleted = 0, usersWithTraining = 0;
    for (const t of trainingRows) {
      totalAssigned += t.assigned;
      totalCompleted += t.completed;
      if (t.assigned > 0) usersWithTraining++;
    }

    // 4) ROI metrics
    const overallClickRate = totalSent > 0 ? Math.round((totalClicked / totalSent) * 100) : 0;
    const overallSubmitRate = totalSent > 0 ? Math.round((totalSubmitted / totalSent) * 100) : 0;
    const trainingCompletionRate = totalAssigned > 0 ? Math.round((totalCompleted / totalAssigned) * 100) : 0;

    // Risk score 0-100, lower is better: clicks and credential submits hurt,
    // completed training helps.
    const riskScore = Math.min(100, Math.max(0,
      100 - (overallClickRate * 2) - (overallSubmitRate * 5) + (trainingCompletionRate * 0.5)
    ));

    // Trend: most recent vs previous campaign WITH sends (skip empty ones)
    let trend = 'neutral';
    const withSends = campaignStats.filter(c => c.sent > 0);
    if (withSends.length >= 2) {
      if (withSends[0].click_rate < withSends[1].click_rate) trend = 'improving';
      else if (withSends[0].click_rate > withSends[1].click_rate) trend = 'declining';
    }

    return json({
      customer_id: customerId,
      generated_at: new Date().toISOString(),
      summary: {
        total_campaigns: campaigns.length,
        total_emails_sent: totalSent,
        overall_click_rate: overallClickRate,
        overall_submit_rate: overallSubmitRate,
        training_completion_rate: trainingCompletionRate,
        risk_score: Math.round(riskScore),
        trend,
      },
      campaigns: campaignStats, // newest first, max 12
      training: {
        total_users: emails.size,
        users_with_training: usersWithTraining,
        total_completed: totalCompleted,
        total_assigned: totalAssigned,
        completion_rate: trainingCompletionRate,
      },
    });

  } catch (e) {
    return json({ error: 'Failed to generate ROI report: ' + e.message }, 500);
  }
}
