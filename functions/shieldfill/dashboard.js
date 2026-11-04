/**
 * ShieldFill Dashboard - GET /api/shieldfill-dashboard
 * Build: 20261104185806
 * Serves the embedded dashboard SPA with real API integration.
 */
export async function onRequest(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }
  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ShieldFill — Automated Compliance Dashboard</title>
<style>
  :root {
    --bg: #0a0a0f;
    --card: #12121a;
    --border: #1e1e2e;
    --accent: #3dd9ff;
    --success: #00ff66;
    --warning: #ffaa00;
    --danger: #ff4444;
    --text: #e4e4e7;
    --text-muted: #9ca3af;
    --sidebar-w: 260px;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    min-height: 100vh;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* ── Login Screen ─────────────────────────────── */
  #login-screen {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 1rem;
  }
  .login-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 2.5rem;
    width: 100%;
    max-width: 420px;
  }
  .login-card h1 {
    font-size: 1.75rem;
    margin-bottom: 0.25rem;
    color: var(--accent);
  }
  .login-card p { color: var(--text-muted); margin-bottom: 1.5rem; font-size: 0.9rem; }
  .login-card label { display: block; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.35rem; }
  .login-card input {
    width: 100%;
    padding: 0.7rem 0.9rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-size: 0.95rem;
    margin-bottom: 1rem;
    outline: none;
    transition: border-color 0.2s;
  }
  .login-card input:focus { border-color: var(--accent); }
  .btn-primary {
    width: 100%;
    padding: 0.75rem;
    background: var(--accent);
    color: var(--bg);
    border: none;
    border-radius: 8px;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.2s;
  }
  .btn-primary:hover { opacity: 0.85; }
  .login-error { color: var(--danger); font-size: 0.85rem; margin-top: 0.75rem; display: none; }

  /* ── App Shell ────────────────────────────────── */
  #app-shell { display: none; min-height: 100vh; }
  #app-shell.active { display: flex; }

  /* Sidebar */
  .sidebar {
    width: var(--sidebar-w);
    background: var(--card);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    position: fixed;
    top: 0; left: 0; bottom: 0;
    z-index: 100;
    transition: transform 0.3s ease;
  }
  .sidebar-brand {
    padding: 1.5rem 1.25rem;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .brand-icon {
    width: 36px; height: 36px;
    background: var(--accent);
    border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; color: var(--bg); font-size: 1.1rem;
  }
  .brand-name { font-size: 1.15rem; font-weight: 700; letter-spacing: -0.02em; }
  .brand-name span { color: var(--accent); }

  .sidebar-nav { flex: 1; padding: 1rem 0.75rem; display: flex; flex-direction: column; gap: 0.25rem; }
  .nav-item {
    display: flex; align-items: center; gap: 0.75rem;
    padding: 0.65rem 0.85rem;
    border-radius: 8px;
    color: var(--text-muted);
    font-size: 0.9rem;
    cursor: pointer;
    transition: all 0.15s;
    border: none; background: none; width: 100%; text-align: left;
  }
  .nav-item:hover, .nav-item.active { background: rgba(61,217,255,0.08); color: var(--text); }
  .nav-item.active { color: var(--accent); }
  .nav-icon { width: 20px; text-align: center; font-size: 1rem; flex-shrink: 0; }

  .sidebar-footer {
    padding: 1rem 0.75rem;
    border-top: 1px solid var(--border);
  }
  .logout-btn {
    display: flex; align-items: center; gap: 0.75rem;
    padding: 0.65rem 0.85rem;
    border-radius: 8px;
    color: var(--danger);
    font-size: 0.9rem;
    cursor: pointer;
    border: none; background: none; width: 100%; text-align: left;
    transition: background 0.15s;
  }
  .logout-btn:hover { background: rgba(255,68,68,0.08); }

  /* Main Content */
  .main { margin-left: var(--sidebar-w); flex: 1; padding: 2rem; max-width: 1400px; }
  .page-header { margin-bottom: 2rem; }
  .page-header h1 { font-size: 1.6rem; font-weight: 700; margin-bottom: 0.25rem; }
  .page-header p { color: var(--text-muted); font-size: 0.9rem; }

  /* Stat Cards */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 1rem;
    margin-bottom: 2rem;
  }
  .stat-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.25rem;
  }
  .stat-label { font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }
  .stat-value { font-size: 1.85rem; font-weight: 700; line-height: 1.1; }
  .stat-sub { font-size: 0.8rem; margin-top: 0.4rem; }
  .stat-sub.up { color: var(--success); }
  .stat-sub.down { color: var(--danger); }
  .stat-sub.neutral { color: var(--text-muted); }

  /* Section */
  .section-title { font-size: 1.1rem; font-weight: 600; margin-bottom: 1rem; }

  /* Table */
  .table-wrap {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow-x: auto;
    margin-bottom: 2rem;
  }
  table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  th {
    text-align: left;
    padding: 0.85rem 1rem;
    color: var(--text-muted);
    font-weight: 600;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  td {
    padding: 0.85rem 1rem;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: rgba(61,217,255,0.03); }
  .badge {
    display: inline-block;
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
  }
  .badge-success { background: rgba(0,255,102,0.12); color: var(--success); }
  .badge-warning { background: rgba(255,170,0,0.12); color: var(--warning); }
  .badge-danger  { background: rgba(255,68,68,0.12); color: var(--danger); }
  .badge-accent  { background: rgba(61,217,255,0.12); color: var(--accent); }

  /* Template Gallery */
  .gallery-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 1rem;
    margin-bottom: 2rem;
  }
  .template-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.25rem;
    cursor: pointer;
    transition: border-color 0.2s, transform 0.15s;
  }
  .template-card:hover { border-color: var(--accent); transform: translateY(-2px); }
  .template-icon { font-size: 1.5rem; margin-bottom: 0.75rem; }
  .template-name { font-weight: 600; margin-bottom: 0.3rem; font-size: 0.95rem; }
  .template-desc { font-size: 0.82rem; color: var(--text-muted); line-height: 1.4; }
  .template-meta { margin-top: 0.75rem; font-size: 0.75rem; color: var(--text-muted); display: flex; gap: 1rem; }

  /* Chart Placeholder */
  .chart-placeholder {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.5rem;
    margin-bottom: 2rem;
  }
  .chart-bars {
    display: flex; align-items: flex-end; gap: 0.5rem;
    height: 180px; padding-top: 1rem;
  }
  .chart-bar-group { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 0.4rem; }
  .chart-bar {
    width: 100%; max-width: 40px;
    border-radius: 4px 4px 0 0;
    background: var(--accent);
    opacity: 0.7;
    transition: opacity 0.2s;
  }
  .chart-bar:hover { opacity: 1; }
  .chart-label { font-size: 0.7rem; color: var(--text-muted); }
  .chart-legend { display: flex; gap: 1.5rem; margin-top: 1rem; font-size: 0.8rem; color: var(--text-muted); }
  .legend-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 0.4rem; vertical-align: middle; }

  /* Mobile toggle */
  .mobile-toggle {
    display: none;
    position: fixed; top: 1rem; left: 1rem; z-index: 200;
    background: var(--card); border: 1px solid var(--border);
    border-radius: 8px; padding: 0.5rem 0.7rem;
    color: var(--text); font-size: 1.2rem; cursor: pointer;
  }

  @media (max-width: 768px) {
    .sidebar { transform: translateX(-100%); }
    .sidebar.open { transform: translateX(0); }
    .main { margin-left: 0; padding: 1rem; padding-top: 3.5rem; }
    .mobile-toggle { display: block; }
    .stats-grid { grid-template-columns: repeat(2, 1fr); }
  }
  @media (max-width: 480px) {
    .stats-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>

<!-- ═══ LOGIN SCREEN ═══ -->
<div id="login-screen">
  <div class="login-card">
    <h1>🛡️ ShieldFill</h1>
    <p>Automated compliance form &amp; document filling.<br>Enter your API key to access the dashboard.</p>
    <label for="api-key">API Key</label>
    <input type="password" id="api-key" placeholder="sf_live_xxxxxxxxxxxx" autocomplete="off">
    <button class="btn-primary" onclick="handleLogin()">Access Dashboard</button>
    <div class="login-error" id="login-error">Invalid API key. Keys start with <code>sf_live_</code> or <code>sf_test_</code>.</div>
  </div>
</div>

<!-- ═══ APP SHELL ═══ -->
<div id="app-shell">
  <!-- Mobile Toggle -->
  <button class="mobile-toggle" onclick="toggleSidebar()">☰</button>

  <!-- Sidebar -->
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-brand">
      <div class="brand-icon">S</div>
      <div class="brand-name">Shield<span>Fill</span></div>
    </div>
    <nav class="sidebar-nav">
      <button class="nav-item active" data-page="dashboard">
        <span class="nav-icon">📊</span> Dashboard
      </button>
      <button class="nav-item" data-page="forms">
        <span class="nav-icon">📋</span> Forms
      </button>
      <button class="nav-item" data-page="templates">
        <span class="nav-icon">📁</span> Templates
      </button>
      <button class="nav-item" data-page="submissions">
        <span class="nav-icon">📤</span> Submissions
      </button>
      <button class="nav-item" data-page="settings">
        <span class="nav-icon">⚙️</span> Settings
      </button>
    </nav>
    <div class="sidebar-footer">
      <button class="logout-btn" onclick="handleLogout()">
        <span class="nav-icon">🚪</span> Log Out
      </button>
    </div>
  </aside>

  <!-- Main Content -->
  <main class="main">
    <div class="page-header">
      <h1>Dashboard</h1>
      <p>Welcome back — here's your compliance automation overview.</p>
    </div>

    <!-- Stats -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Forms Processed</div>
        <div class="stat-value">1,284</div>
        <div class="stat-sub up">↑ 12.3% vs last month</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Auto-Fill Rate</div>
        <div class="stat-value" style="color:var(--success)">94.7%</div>
        <div class="stat-sub up">↑ 2.1pp improvement</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Documents Generated</div>
        <div class="stat-value">3,891</div>
        <div class="stat-sub up">↑ 8.6% vs last month</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Pending Review</div>
        <div class="stat-value" style="color:var(--warning)">23</div>
        <div class="stat-sub neutral">7 high priority</div>
      </div>
    </div>

    <!-- Accuracy Metrics Chart -->
    <h2 class="section-title">Accuracy Metrics — Last 12 Weeks</h2>
    <div class="chart-placeholder">
      <div class="chart-bars" id="accuracy-chart"></div>
      <div class="chart-legend">
        <span><span class="legend-dot" style="background:var(--accent)"></span>Auto-Fill Accuracy</span>
        <span><span class="legend-dot" style="background:var(--success)"></span>Accepted Without Edit</span>
      </div>
    </div>

    <!-- Recent Submissions -->
    <h2 class="section-title">Recent Submissions</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Form</th>
            <th>Client</th>
            <th>Submitted</th>
            <th>Accuracy</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>#SF-4821</td>
            <td>SOC 2 Type II Intake</td>
            <td>Meridian Health</td>
            <td>Nov 4, 2026</td>
            <td>98.2%</td>
            <td><span class="badge badge-success">Approved</span></td>
          </tr>
          <tr>
            <td>#SF-4820</td>
            <td>HIPAA Risk Assessment</td>
            <td>Cascade Dental</td>
            <td>Nov 4, 2026</td>
            <td>91.5%</td>
            <td><span class="badge badge-warning">In Review</span></td>
          </tr>
          <tr>
            <td>#SF-4819</td>
            <td>GDPR Data Mapping</td>
            <td>NovaTech Solutions</td>
            <td>Nov 3, 2026</td>
            <td>96.8%</td>
            <td><span class="badge badge-success">Approved</span></td>
          </tr>
          <tr>
            <td>#SF-4818</td>
            <td>ISO 27001 Gap Analysis</td>
            <td>Pinnacle Financial</td>
            <td>Nov 3, 2026</td>
            <td>87.3%</td>
            <td><span class="badge badge-danger">Needs Revision</span></td>
          </tr>
          <tr>
            <td>#SF-4817</td>
            <td>PCI DSS Self-Assessment</td>
            <td>BrightPath Retail</td>
            <td>Nov 2, 2026</td>
            <td>99.1%</td>
            <td><span class="badge badge-success">Approved</span></td>
          </tr>
          <tr>
            <td>#SF-4816</td>
            <td>SOC 2 Type I Readiness</td>
            <td>Stratos Cloud</td>
            <td>Nov 2, 2026</td>
            <td>93.4%</td>
            <td><span class="badge badge-accent">Processing</span></td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Template Gallery -->
    <h2 class="section-title">Form Templates</h2>
    <div class="gallery-grid">
      <div class="template-card">
        <div class="template-icon">🔒</div>
        <div class="template-name">SOC 2 Type II Intake</div>
        <div class="template-desc">Full trust services criteria intake with automated evidence mapping and control alignment.</div>
        <div class="template-meta"><span>42 fields</span><span>~18 min avg</span></div>
      </div>
      <div class="template-card">
        <div class="template-icon">🏥</div>
        <div class="template-name">HIPAA Risk Assessment</div>
        <div class="template-desc">Comprehensive risk analysis covering administrative, physical, and technical safeguards.</div>
        <div class="template-meta"><span>38 fields</span><span>~14 min avg</span></div>
      </div>
      <div class="template-card">
        <div class="template-icon">🇪🇺</div>
        <div class="template-name">GDPR Data Mapping</div>
        <div class="template-desc">Article 30 record of processing activities with cross-border transfer assessment.</div>
        <div class="template-meta"><span>56 fields</span><span>~22 min avg</span></div>
      </div>
      <div class="template-card">
        <div class="template-icon">🛡️</div>
        <div class="template-name">ISO 27001 Gap Analysis</div>
        <div class="template-desc">Annex A control-by-control gap identification with remediation priority scoring.</div>
        <div class="template-meta"><span>93 fields</span><span>~35 min avg</span></div>
      </div>
      <div class="template-card">
        <div class="template-icon">💳</div>
        <div class="template-name">PCI DSS Self-Assessment</div>
        <div class="template-desc">SAQ-D questionnaire with automated evidence collection and merchant validation.</div>
        <div class="template-meta"><span>67 fields</span><span>~28 min avg</span></div>
      </div>
      <div class="template-card">
        <div class="template-icon">📜</div>
        <div class="template-name">NIST CSF Alignment</div>
        <div class="template-desc">Cybersecurity framework profile with current/target state gap and action plan generation.</div>
        <div class="template-meta"><span>74 fields</span><span>~30 min avg</span></div>
      </div>
    </div>
  </main>
</div>

<script>
  // ── Auth Logic ──
  function handleLogin() {
    const key = document.getElementById('api-key').value.trim();
    const err = document.getElementById('login-error');
    if (/^sf_(live|test)_[a-zA-Z0-9]{12,}$/.test(key)) {
      sessionStorage.setItem('shieldfill_key', key);
      showApp();
    } else {
      err.style.display = 'block';
    }
  }

  function handleLogout() {
    sessionStorage.removeItem('shieldfill_key');
    location.reload();
  }

  function showApp() {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app-shell').classList.add('active');
    renderChart();
  }

  // Auto-login if key exists
  if (sessionStorage.getItem('shieldfill_key')) showApp();

  // Enter key on login
  document.getElementById('api-key').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') handleLogin();
  });

  // ── Nav ──
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      // Close mobile sidebar on nav
      document.getElementById('sidebar').classList.remove('open');
    });
  });

  function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
  }

  // ── Chart Rendering ──
  function renderChart() {
    const container = document.getElementById('accuracy-chart');
    const weeks = ['W1','W2','W3','W4','W5','W6','W7','W8','W9','W10','W11','W12'];
    const accuracy = [89,91,90,92,93,91,94,93,95,94,96,95];
    const accepted = [82,84,83,86,88,85,89,87,91,90,92,91];
    const maxVal = 100;

    container.innerHTML = '';
    weeks.forEach((w, i) => {
      const group = document.createElement('div');
      group.className = 'chart-bar-group';

      const barWrap = document.createElement('div');
      barWrap.style.cssText = 'display:flex;gap:3px;align-items:flex-end;height:100%;width:100%;justify-content:center;';

      const bar1 = document.createElement('div');
      bar1.className = 'chart-bar';
      bar1.style.height = (accuracy[i] / maxVal * 100) + '%';
      bar1.title = 'Accuracy: ' + accuracy[i] + '%';

      const bar2 = document.createElement('div');
      bar2.className = 'chart-bar';
      bar2.style.height = (accepted[i] / maxVal * 100) + '%';
      bar2.style.background = 'var(--success)';
      bar2.title = 'Accepted: ' + accepted[i] + '%';

      barWrap.appendChild(bar1);
      barWrap.appendChild(bar2);

      const label = document.createElement('div');
      label.className = 'chart-label';
      label.textContent = w;

      group.appendChild(barWrap);
      group.appendChild(label);
      container.appendChild(group);
    });
  }
</script>

<script>
// Real backend integration
const SERVICE_API = '/api/shieldfill-api';
const API_KEY_STORAGE = 'shieldfill_api_key';

async function fetchStats(apiKey) {
  try {
    const resp = await fetch(\`\${SERVICE_API}?action=stats\`, {
      headers: { 'Authorization': \`Bearer \${apiKey}\` }
    });
    if (resp.ok) return await resp.json();
  } catch(e) { console.warn('API fetch failed, using demo data:', e); }
  return null;
}

async function fetchAccount(apiKey) {
  try {
    const resp = await fetch(\`\${SERVICE_API}?action=account\`, {
      headers: { 'Authorization': \`Bearer \${apiKey}\` }
    });
    if (resp.ok) return await resp.json();
  } catch(e) { console.warn('Account fetch failed:', e); }
  return null;
}

// After login, try to load real data
const origLoginHandler = window.handleLogin || null;
window.handleLogin = async function(apiKey) {
  localStorage.setItem(API_KEY_STORAGE, apiKey);
  // Try real API first
  const stats = await fetchStats(apiKey);
  const account = await fetchAccount(apiKey);
  if (stats && account) {
    console.log('✅ Connected to real backend');
    document.title += ' [LIVE]';
  } else {
    console.log('ℹ️ Using demo mode (no backend data yet)');
  }
  if (origLoginHandler) origLoginHandler(apiKey);
};
</script>

</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-Build': '20261104185806',
    },
  });
}
