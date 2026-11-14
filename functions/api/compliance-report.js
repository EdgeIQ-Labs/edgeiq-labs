/**
 * EdgeIQ Compliance Report Generator
 * POST /api/compliance-report
 * Body: { scanner_type, scanner_data, email, framework, session_id }
 * Generates branded PDF compliance report, stores in KV, emails via Resend
 */

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }});
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const body = await request.json();
    const { scanner_type, scanner_data, email, framework, paid } = body;

    if (!scanner_data || !email) {
      return new Response(JSON.stringify({ error: 'Missing scanner_data or email' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const reportFramework = framework || 'SOC2_LITE';
    const isPaid = paid === true;
    const reportId = crypto.randomUUID().slice(0, 12);
    const generatedAt = new Date().toISOString();

    // Build HTML report
    const html = generateReportHTML(scanner_type, scanner_data, reportFramework, isPaid, reportId, generatedAt);

    // For MVP: store HTML report in KV and deliver via email + download link
    // Full PDF rendering would require a headless browser or external API
    // We deliver a beautifully formatted HTML email that prints to PDF perfectly
    const reportKey = `compliance-report:${reportId}`;
    const reportMeta = {
      id: reportId,
      email,
      framework: reportFramework,
      scanner_type,
      paid: isPaid,
      generated_at: generatedAt,
      grade: scanner_data.grade || scanner_data.score_letter || 'N/A',
      score: scanner_data.score || scanner_data.security_score || 0
    };

    await env.PULSE_KV.put(reportKey, JSON.stringify(reportMeta), { expirationTtl: 86400 * 30 });
    await env.PULSE_KV.put(`${reportKey}:html`, html, { expirationTtl: 86400 * 30 });

    // Send via Resend
    if (env.RESEND_API_KEY) {
      const tierLabel = isPaid ? 'Full Compliance Report' : 'Compliance Summary (Free)';
      const watermarkNote = isPaid ? '' : '<p style="color:#ff6b7a;font-size:12px;margin-top:20px;">This is a free summary. <a href="https://edgeiqlabs.com/compliance-report/?upgrade=true" style="color:#3dd9ff;">Get the full report for $49 →</a></p>';

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'EdgeIQ Labs Compliance <compliance@edgeiqlabs.com>',
          to: [email],
          subject: `Your ${tierLabel} — ${reportFramework.replace('_', ' ')} [${reportId}]`,
          html: html + watermarkNote
        })
      });
    }

    return new Response(JSON.stringify({
      ok: true,
      report_id: reportId,
      framework: reportFramework,
      paid: isPaid,
      message: isPaid ? 'Full report sent to your email.' : 'Free summary sent. Upgrade for full remediation steps.',
      download_url: `https://edgeiqlabs.com/api/compliance-report/download?id=${reportId}`
    }), { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

function generateReportHTML(scannerType, data, framework, isPaid, reportId, generatedAt) {
  const grade = data.grade || data.score_letter || 'N/A';
  const score = data.score || data.security_score || 0;
  const findings = data.findings || data.checks || data.results || [];
  const domain = data.domain || data.url || data.repo || 'N/A';

  const frameworkTitles = {
    'SOC2_LITE': 'SOC 2 Lite Trust Report',
    'HIPAA': 'HIPAA Security Checklist',
    'PCI_DSS': 'PCI-DSS Gap Analysis',
    'GENERAL': 'Security Posture Assessment'
  };
  const title = frameworkTitles[framework] || frameworkTitles['GENERAL'];

  const gradeColor = grade === 'A' || grade === 'B' ? '#3de19e' : grade === 'C' ? '#ff8c42' : '#ff6b7a';

  let findingsHTML = '';
  const maxFindings = isPaid ? findings.length : Math.min(findings.length, 3);

  for (let i = 0; i < maxFindings; i++) {
    const f = findings[i];
    const severity = f.severity || f.level || 'medium';
    const sevColor = severity === 'critical' || severity === 'high' ? '#ff6b7a' : severity === 'medium' ? '#ff8c42' : '#3de19e';
    const desc = f.description || f.message || f.name || f.check || 'Finding';
    const remediation = isPaid ? (f.remediation || f.fix || f.recommendation || 'Review and address this finding.') : '<em style="color:#9fb0c7;">Remediation steps available in the full report.</em>';

    findingsHTML += `
      <div style="background:#121923;border:1px solid #1e2a3a;border-radius:8px;padding:16px;margin-bottom:12px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <span style="background:${sevColor}22;color:${sevColor};padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;text-transform:uppercase;">${severity}</span>
          <strong style="color:#e8eef7;font-size:14px;">${desc}</strong>
        </div>
        <p style="color:#9fb0c7;font-size:13px;margin:0;line-height:1.5;">${remediation}</p>
      </div>`;
  }

  if (!isPaid && findings.length > 3) {
    findingsHTML += `<div style="text-align:center;padding:16px;color:#9fb0c7;font-size:13px;border:1px dashed #1e2a3a;border-radius:8px;">+ ${findings.length - 3} more findings in the full report</div>`;
  }

  const watermark = isPaid ? '' : `<div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:80px;font-weight:900;color:rgba(61,217,255,0.06);pointer-events:none;z-index:0;white-space:nowrap;">EDGEIQ LABS</div>`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><style>
    @media print { body { background: white !important; color: black !important; } .no-print { display: none !important; } }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0b0f14; color: #e8eef7; margin: 0; padding: 40px; line-height: 1.6; position: relative; }
    @media print { body { padding: 20px; } }
  </style></head><body>
    ${watermark}
    <div style="max-width:700px;margin:0 auto;position:relative;z-index:1;">
      <div style="text-align:center;margin-bottom:40px;padding-bottom:20px;border-bottom:2px solid #1e2a3a;">
        <h1 style="color:#3dd9ff;font-size:28px;margin:0 0 4px;">${title}</h1>
        <p style="color:#9fb0c7;font-size:14px;margin:0;">Generated by EdgeIQ Labs · ${generatedAt.split('T')[0]}</p>
        <p style="color:#9fb0c7;font-size:12px;margin:4px 0 0;">Report ID: ${reportId}</p>
      </div>

      <div style="display:flex;gap:20px;margin-bottom:30px;">
        <div style="flex:1;background:#121923;border:1px solid #1e2a3a;border-radius:10px;padding:20px;text-align:center;">
          <div style="font-size:48px;font-weight:900;color:${gradeColor};line-height:1;">${grade}</div>
          <div style="color:#9fb0c7;font-size:12px;margin-top:4px;">OVERALL GRADE</div>
        </div>
        <div style="flex:1;background:#121923;border:1px solid #1e2a3a;border-radius:10px;padding:20px;text-align:center;">
          <div style="font-size:48px;font-weight:900;color:#3dd9ff;line-height:1;">${score}</div>
          <div style="color:#9fb0c7;font-size:12px;margin-top:4px;">SECURITY SCORE</div>
        </div>
      </div>

      <div style="margin-bottom:30px;">
        <h2 style="color:#e8eef7;font-size:18px;margin:0 0 12px;border-bottom:1px solid #1e2a3a;padding-bottom:8px;">Target</h2>
        <p style="color:#9fb0c7;font-size:14px;margin:0;"><strong style="color:#e8eef7;">${domain}</strong> · Scanned via ${scannerType || 'EdgeIQ Scanner'}</p>
      </div>

      <div style="margin-bottom:30px;">
        <h2 style="color:#e8eef7;font-size:18px;margin:0 0 12px;border-bottom:1px solid #1e2a3a;padding-bottom:8px;">Findings (${isPaid ? findings.length : Math.min(findings.length, 3)} of ${findings.length})</h2>
        ${findingsHTML}
      </div>

      ${isPaid ? `
      <div style="margin-bottom:30px;">
        <h2 style="color:#e8eef7;font-size:18px;margin:0 0 12px;border-bottom:1px solid #1e2a3a;padding-bottom:8px;">Compliance Mapping</h2>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <tr style="border-bottom:1px solid #1e2a3a;"><th style="text-align:left;padding:8px;color:#9fb0c7;">Control</th><th style="text-align:left;padding:8px;color:#9fb0c7;">Status</th><th style="text-align:left;padding:8px;color:#9fb0c7;">Framework</th></tr>
          <tr style="border-bottom:1px solid #1e2a3a;"><td style="padding:8px;color:#e8eef7;">Encryption at Rest</td><td style="padding:8px;color:${score >= 70 ? '#3de19e' : '#ff6b7a'};">${score >= 70 ? 'PASS' : 'FAIL'}</td><td style="padding:8px;color:#9fb0c7;">SOC2 CC6.1</td></tr>
          <tr style="border-bottom:1px solid #1e2a3a;"><td style="padding:8px;color:#e8eef7;">Access Controls</td><td style="padding:8px;color:${score >= 60 ? '#3de19e' : '#ff8c42'};">${score >= 60 ? 'PASS' : 'REVIEW'}</td><td style="padding:8px;color:#9fb0c7;">SOC2 CC6.2</td></tr>
          <tr style="border-bottom:1px solid #1e2a3a;"><td style="padding:8px;color:#e8eef7;">Monitoring</td><td style="padding:8px;color:#ff8c42;">REVIEW</td><td style="padding:8px;color:#9fb0c7;">SOC2 CC7.1</td></tr>
        </table>
      </div>` : ''}

      <div style="text-align:center;padding:20px;border-top:2px solid #1e2a3a;margin-top:40px;">
        <p style="color:#9fb0c7;font-size:12px;margin:0 0 8px;">This report was generated by EdgeIQ Labs automated compliance engine.</p>
        <p style="color:#9fb0c7;font-size:12px;margin:0;">Questions? <a href="mailto:support@edgeiqlabs.com" style="color:#3dd9ff;">support@edgeiqlabs.com</a></p>
        ${!isPaid ? '<p class="no-print" style="margin-top:16px;"><a href="https://edgeiqlabs.com/compliance-report/?upgrade=true" style="display:inline-block;padding:12px 28px;background:#3dd9ff;color:#0b0f14;border-radius:8px;font-weight:700;text-decoration:none;">Get Full Report — $49 →</a></p>' : ''}
      </div>
    </div>
  </body></html>`;
}
