/**
 * PhishSim ROI Dashboard API
 * GET /api/phishsim/roi?cid=X
 * 
 * Aggregates GoPhish campaign stats + training completion data
 * Returns time-series metrics for ROI visualization
 * Auth: X-Customer-ID header or ?cid= query param
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

async function gophishProxy(env, customerId, path) {
  const url = `${env.PHISHSIM_MGR_URL}/proxy/${customerId}${path}`;
  const resp = await fetch(url, {
    headers: {
      'X-Provision-Secret': env.PHISHSIM_SECRET,
      'Content-Type': 'application/json',
    },
  });
  if (!resp.ok) return null;
  try { return await resp.json(); } catch { return null; }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const { request, env } = context;
  const url = new URL(request.url);
  const customerId = url.searchParams.get('cid') || request.headers.get('X-Customer-ID');

  if (!customerId) {
    return json({ error: 'Missing customer ID' }, 400);
  }

  // Verify customer exists in KV
  const instanceKey = `phishsim:instance:${customerId}`;
  const instance = await env.PHISHSIM_KV.get(instanceKey, 'json');
  if (!instance) {
    return json({ error: 'Invalid customer ID' }, 404);
  }

  try {
    // Fetch campaigns from GoPhish
    const campaigns = await gophishProxy(env, customerId, '/api/campaigns/') || [];
    
    // Fetch training completion data
    const trainingRoster = (await env.PULSE_KV.get(`training:roster:${customerId}`, 'json')) || [];
    const trainingData = [];
    let totalCompleted = 0;
    let totalAssigned = 0;
    
    for (const userEmail of trainingRoster) {
      const progress = (await env.PULSE_KV.get(`training:progress:${userEmail.toLowerCase()}`, 'json')) || {};
      const assignments = (await env.PULSE_KV.get(`training:assignments:${userEmail.toLowerCase()}`, 'json')) || [];
      const completedModules = Object.keys(progress).length;
      totalCompleted += completedModules;
      totalAssigned += assignments.length;
      trainingData.push({
        email: userEmail,
        completed: completedModules,
        assigned: assignments.length,
      });
    }

    // Aggregate campaign metrics by date
    const campaignStats = [];
    let totalSent = 0, totalOpened = 0, totalClicked = 0, totalSubmitted = 0;
    
    for (const campaign of campaigns) {
      const results = campaign.results || [];
      const launchDate = campaign.launch_date ? campaign.launch_date.substring(0, 10) : 'unknown';
      
      let sent = 0, opened = 0, clicked = 0, submitted = 0;
      for (const r of results) {
        sent++;
        if (r.status === 'Email Opened' || r.status === 'Clicked Link' || r.status === 'Submitted Data') opened++;
        if (r.status === 'Clicked Link' || r.status === 'Submitted Data') clicked++;
        if (r.status === 'Submitted Data') submitted++;
      }
      
      totalSent += sent;
      totalOpened += opened;
      totalClicked += clicked;
      totalSubmitted += submitted;
      
      campaignStats.push({
        id: campaign.id,
        name: campaign.name,
        date: launchDate,
        sent,
        opened,
        clicked,
        submitted,
        click_rate: sent > 0 ? Math.round((clicked / sent) * 100) : 0,
        submit_rate: sent > 0 ? Math.round((submitted / sent) * 100) : 0,
      });
    }

    // Sort by date descending
    campaignStats.sort((a, b) => b.date.localeCompare(a.date));

    // Calculate ROI metrics
    const overallClickRate = totalSent > 0 ? Math.round((totalClicked / totalSent) * 100) : 0;
    const overallSubmitRate = totalSent > 0 ? Math.round((totalSubmitted / totalSent) * 100) : 0;
    const trainingCompletionRate = totalAssigned > 0 ? Math.round((totalCompleted / totalAssigned) * 100) : 0;
    
    // Risk score: lower is better (click rate + submit rate weighted)
    const riskScore = Math.max(0, 100 - (overallClickRate * 2) - (overallSubmitRate * 5) + (trainingCompletionRate * 0.5));

    // Trend: compare last 2 campaigns
    let trend = 'neutral';
    if (campaignStats.length >= 2) {
      const recent = campaignStats[0].click_rate;
      const previous = campaignStats[1].click_rate;
      if (recent < previous) trend = 'improving';
      else if (recent > previous) trend = 'declining';
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
      campaigns: campaignStats.slice(0, 12), // Last 12 campaigns max
      training: {
        total_users: trainingRoster.length,
        total_completed: totalCompleted,
        total_assigned: totalAssigned,
        completion_rate: trainingCompletionRate,
      },
    });

  } catch (e) {
    return json({ error: 'Failed to generate ROI report: ' + e.message }, 500);
  }
}
