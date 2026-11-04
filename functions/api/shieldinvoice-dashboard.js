/**
 * ShieldInvoice Dashboard - GET /api/shieldinvoice-dashboard
 * Serves the embedded dashboard SPA.
 */
export async function onRequest(context) {
  const { request } = context;
  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ShieldInvoice | Dashboard</title>
    <style>
        :root {
            --bg: #0a0a0f;
            --card: #12121a;
            --border: #1e1e2e;
            --accent: #3dd9ff;
            --success: #00ff66;
            --warning: #ffaa00;
            --danger: #ff4444;
            --text-primary: #ffffff;
            --text-secondary: #a0a0b0;
            --sidebar-width: 260px;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: system-ui, -apple-system, sans-serif;
            background: var(--bg);
            color: var(--text-primary);
            min-height: 100vh;
            overflow-x: hidden;
        }

        /* Login Screen */
        #login-screen {
            position: fixed;
            inset: 0;
            background: var(--bg);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
            transition: opacity 0.3s ease;
        }

        .login-card {
            background: var(--card);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 48px;
            width: 100%;
            max-width: 420px;
            text-align: center;
        }

        .login-logo {
            font-size: 32px;
            font-weight: 700;
            color: var(--accent);
            margin-bottom: 8px;
            letter-spacing: -0.5px;
        }

        .login-subtitle {
            color: var(--text-secondary);
            margin-bottom: 32px;
            font-size: 14px;
        }

        .input-group {
            margin-bottom: 20px;
            text-align: left;
        }

        .input-group label {
            display: block;
            font-size: 13px;
            color: var(--text-secondary);
            margin-bottom: 8px;
            font-weight: 500;
        }

        .input-group input {
            width: 100%;
            padding: 12px 16px;
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 8px;
            color: var(--text-primary);
            font-size: 14px;
            outline: none;
            transition: border-color 0.2s;
        }

        .input-group input:focus {
            border-color: var(--accent);
        }

        .btn-primary {
            width: 100%;
            padding: 12px;
            background: var(--accent);
            color: var(--bg);
            border: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: opacity 0.2s;
        }

        .btn-primary:hover { opacity: 0.9; }

        .login-error {
            color: var(--danger);
            font-size: 13px;
            margin-top: 12px;
            min-height: 20px;
        }

        /* App Layout */
        #app {
            display: none;
            min-height: 100vh;
        }

        #app.active {
            display: flex;
        }

        /* Sidebar */
        .sidebar {
            width: var(--sidebar-width);
            background: var(--card);
            border-right: 1px solid var(--border);
            display: flex;
            flex-direction: column;
            position: fixed;
            top: 0;
            left: 0;
            bottom: 0;
            z-index: 100;
        }

        .sidebar-header {
            padding: 24px;
            border-bottom: 1px solid var(--border);
        }

        .brand {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .brand-icon {
            width: 36px;
            height: 36px;
            background: linear-gradient(135deg, var(--accent), #2ba8cc);
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 700;
            color: var(--bg);
            font-size: 18px;
        }

        .brand-text h1 {
            font-size: 16px;
            font-weight: 700;
            letter-spacing: -0.3px;
        }

        .brand-text span {
            font-size: 11px;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .nav-menu {
            flex: 1;
            padding: 16px 12px;
            list-style: none;
        }

        .nav-item {
            margin-bottom: 4px;
        }

        .nav-link {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 10px 12px;
            color: var(--text-secondary);
            text-decoration: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            transition: all 0.2s;
            cursor: pointer;
        }

        .nav-link:hover, .nav-link.active {
            background: rgba(61, 217, 255, 0.08);
            color: var(--accent);
        }

        .nav-icon {
            width: 20px;
            height: 20px;
            opacity: 0.7;
        }

        .sidebar-footer {
            padding: 16px 12px;
            border-top: 1px solid var(--border);
        }

        .logout-btn {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 10px 12px;
            color: var(--text-secondary);
            background: none;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            cursor: pointer;
            width: 100%;
            transition: all 0.2s;
        }

        .logout-btn:hover {
            background: rgba(255, 68, 68, 0.08);
            color: var(--danger);
        }

        /* Main Content */
        .main-content {
            flex: 1;
            margin-left: var(--sidebar-width);
            padding: 32px;
            max-width: 1400px;
        }

        .page-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 32px;
        }

        .page-title h2 {
            font-size: 24px;
            font-weight: 700;
            margin-bottom: 4px;
        }

        .page-title p {
            color: var(--text-secondary);
            font-size: 14px;
        }

        .btn-create {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 10px 20px;
            background: var(--accent);
            color: var(--bg);
            border: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: opacity 0.2s;
        }

        .btn-create:hover { opacity: 0.9; }

        /* Stats Grid */
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
            gap: 20px;
            margin-bottom: 32px;
        }

        .stat-card {
            background: var(--card);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 24px;
            transition: border-color 0.2s;
        }

        .stat-card:hover {
            border-color: rgba(61, 217, 255, 0.3);
        }

        .stat-label {
            font-size: 13px;
            color: var(--text-secondary);
            margin-bottom: 8px;
            font-weight: 500;
        }

        .stat-value {
            font-size: 28px;
            font-weight: 700;
            letter-spacing: -0.5px;
        }

        .stat-trend {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            font-size: 12px;
            margin-top: 8px;
            padding: 2px 8px;
            border-radius: 4px;
        }

        .trend-up {
            color: var(--success);
            background: rgba(0, 255, 102, 0.1);
        }

        .trend-down {
            color: var(--danger);
            background: rgba(255, 68, 68, 0.1);
        }

        /* Table Section */
        .table-section {
            background: var(--card);
            border: 1px solid var(--border);
            border-radius: 12px;
            overflow: hidden;
        }

        .table-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 20px 24px;
            border-bottom: 1px solid var(--border);
        }

        .table-title {
            font-size: 16px;
            font-weight: 600;
        }

        .table-actions {
            display: flex;
            gap: 8px;
        }

        .btn-sm {
            padding: 6px 12px;
            background: transparent;
            border: 1px solid var(--border);
            border-radius: 6px;
            color: var(--text-secondary);
            font-size: 13px;
            cursor: pointer;
            transition: all 0.2s;
        }

        .btn-sm:hover {
            border-color: var(--accent);
            color: var(--accent);
        }

        table {
            width: 100%;
            border-collapse: collapse;
        }

        th {
            text-align: left;
            padding: 14px 24px;
            font-size: 12px;
            font-weight: 600;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            border-bottom: 1px solid var(--border);
            background: rgba(255,255,255,0.02);
        }

        td {
            padding: 16px 24px;
            font-size: 14px;
            border-bottom: 1px solid var(--border);
        }

        tr:last-child td {
            border-bottom: none;
        }

        tr:hover td {
            background: rgba(255,255,255,0.02);
        }

        .client-cell {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .client-avatar {
            width: 32px;
            height: 32px;
            border-radius: 8px;
            background: linear-gradient(135deg, #2a2a3a, #1a1a2a);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            font-weight: 600;
            color: var(--accent);
        }

        .client-info strong {
            display: block;
            font-weight: 500;
        }

        .client-info span {
            font-size: 12px;
            color: var(--text-secondary);
        }

        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 10px;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 600;
        }

        .status-paid {
            background: rgba(0, 255, 102, 0.1);
            color: var(--success);
        }

        .status-pending {
            background: rgba(255, 170, 0, 0.1);
            color: var(--warning);
        }

        .status-overdue {
            background: rgba(255, 68, 68, 0.1);
            color: var(--danger);
        }

        .status-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: currentColor;
        }

        .amount {
            font-weight: 600;
            font-variant-numeric: tabular-nums;
        }

        .action-link {
            color: var(--accent);
            text-decoration: none;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
        }

        .action-link:hover {
            text-decoration: underline;
        }

        /* Responsive */
        @media (max-width: 1024px) {
            .sidebar {
                transform: translateX(-100%);
                transition: transform 0.3s ease;
            }
            
            .sidebar.open {
                transform: translateX(0);
            }
            
            .main-content {
                margin-left: 0;
                padding: 20px;
            }
            
            .mobile-toggle {
                display: block;
                position: fixed;
                top: 16px;
                left: 16px;
                z-index: 200;
                background: var(--card);
                border: 1px solid var(--border);
                border-radius: 8px;
                padding: 8px;
                cursor: pointer;
            }
        }

        @media (min-width: 1025px) {
            .mobile-toggle { display: none; }
        }

        @media (max-width: 640px) {
            .stats-grid {
                grid-template-columns: 1fr;
            }
            
            .page-header {
                flex-direction: column;
                align-items: flex-start;
                gap: 16px;
            }
            
            .btn-create {
                width: 100%;
                justify-content: center;
            }
            
            .table-section {
                overflow-x: auto;
            }
            
            table {
                min-width: 600px;
            }
        }
    </style>
</head>
<body>
    <!-- Login Screen -->
    <div id="login-screen">
        <div class="login-card">
            <div class="login-logo">🛡️ ShieldInvoice</div>
            <p class="login-subtitle">Secure Invoice Management Platform</p>
            
            <form id="login-form">
                <div class="input-group">
                    <label for="api-key">API Key</label>
                    <input type="password" id="api-key" placeholder="sk_live_..." autocomplete="off" required>
                </div>
                <button type="submit" class="btn-primary">Access Dashboard</button>
                <div class="login-error" id="login-error"></div>
            </form>
            
            <p style="margin-top: 24px; font-size: 12px; color: var(--text-secondary);">
                Enterprise Plan • $149/month
            </p>
        </div>
    </div>

    <!-- Main App -->
    <div id="app">
        <!-- Mobile Toggle -->
        <button class="mobile-toggle" onclick="toggleSidebar()">
            <svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 12h18M3 6h18M3 18h18"/>
            </svg>
        </button>

        <!-- Sidebar -->
        <aside class="sidebar" id="sidebar">
            <div class="sidebar-header">
                <div class="brand">
                    <div class="brand-icon">S</div>
                    <div class="brand-text">
                        <h1>ShieldInvoice</h1>
                        <span>Enterprise</span>
                    </div>
                </div>
            </div>
            
            <ul class="nav-menu">
                <li class="nav-item">
                    <a class="nav-link active" href="#dashboard">
                        <svg class="nav-icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                            <rect x="3" y="3" width="7" height="7" rx="1"/>
                            <rect x="14" y="3" width="7" height="7" rx="1"/>
                            <rect x="3" y="14" width="7" height="7" rx="1"/>
                            <rect x="14" y="14" width="7" height="7" rx="1"/>
                        </svg>
                        Dashboard
                    </a>
                </li>
                <li class="nav-item">
                    <a class="nav-link" href="#invoices">
                        <svg class="nav-icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                            <polyline points="14 2 14 8 20 8"/>
                            <line x1="16" y1="13" x2="8" y2="13"/>
                            <line x1="16" y1="17" x2="8" y2="17"/>
                            <polyline points="10 9 9 9 8 9"/>
                        </svg>
                        Invoices
                    </a>
                </li>
                <li class="nav-item">
                    <a class="nav-link" href="#templates">
                        <svg class="nav-icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                            <rect x="3" y="3" width="18" height="18" rx="2"/>
                            <path d="M3 9h18"/>
                            <path d="M9 21V9"/>
                        </svg>
                        Templates
                    </a>
                </li>
                <li class="nav-item">
                    <a class="nav-link" href="#settings">
                        <svg class="nav-icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                            <circle cx="12" cy="12" r="3"/>
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                        </svg>
                        Settings
                    </a>
                </li>
            </ul>
            
            <div class="sidebar-footer">
                <button class="logout-btn" onclick="logout()">
                    <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                        <polyline points="16 17 21 12 16 7"/>
                        <line x1="21" y1="12" x2="9" y2="12"/>
                    </svg>
                    Sign Out
                </button>
            </div>
        </aside>

        <!-- Main Content -->
        <main class="main-content">
            <div class="page-header">
                <div class="page-title">
                    <h2>Dashboard</h2>
                    <p>Welcome back, Admin • Last login: Today at 9:41 AM</p>
                </div>
                <button class="btn-create" onclick="createInvoice()">
                    <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                        <line x1="12" y1="5" x2="12" y2="19"/>
                        <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    New Invoice
                </button>
            </div>

            <!-- Stats Cards -->
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-label">Total Invoices</div>
                    <div class="stat-value">1,284</div>
                    <div class="stat-trend trend-up">
                        <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                            <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
                            <polyline points="17 6 23 6 23 12"/>
                        </svg>
                        +12.5% vs last month
                    </div>
                </div>
                
                <div class="stat-card">
                    <div class="stat-label">Pending Payment</div>
                    <div class="stat-value">$48,290</div>
                    <div class="stat-trend trend-down">
                        <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                            <polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/>
                            <polyline points="17 18 23 18 23 12"/>
                        </svg>
                        -3.2% vs last month
                    </div>
                </div>
                
                <div class="stat-card">
                    <div class="stat-label">Paid This Month</div>
                    <div class="stat-value">$127,450</div>
                    <div class="stat-trend trend-up">
                        <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                            <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
                            <polyline points="17 6 23 6 23 12"/>
                        </svg>
                        +24.8% vs last month
                    </div>
                </div>
                
                <div class="stat-card">
                    <div class="stat-label">Overdue</div>
                    <div class="stat-value" style="color: var(--danger);">$12,840</div>
                    <div class="stat-trend trend-down">
                        <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                            <polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/>
                            <polyline points="17 18 23 18 23 12"/>
                        </svg>
                        8 invoices need attention
                    </div>
                </div>
            </div>

            <!-- Recent Invoices Table -->
            <div class="table-section">
                <div class="table-header">
                    <h3 class="table-title">Recent Invoices</h3>
                    <div class="table-actions">
                        <button class="btn-sm">Filter</button>
                        <button class="btn-sm">Export</button>
                    </div>
                </div>
                <table>
                    <thead>
                        <tr>
                            <th>Invoice</th>
                            <th>Client</th>
                            <th>Date</th>
                            <th>Amount</th>
                            <th>Status</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td style="font-weight: 500;">#INV-2024-0892</td>
                            <td>
                                <div class="client-cell">
                                    <div class="client-avatar">AC</div>
                                    <div class="client-info">
                                        <strong>Acme Corp</strong>
                                        <span>acme@example.com</span>
                                    </div>
                                </div>
                            </td>
                            <td style="color: var(--text-secondary);">Nov 3, 2026</td>
                            <td class="amount">$4,500.00</td>
                            <td><span class="status-badge status-paid"><span class="status-dot"></span>Paid</span></td>
                            <td><a class="action-link">View</a></td>
                        </tr>
                        <tr>
                            <td style="font-weight: 500;">#INV-2024-0891</td>
                            <td>
                                <div class="client-cell">
                                    <div class="client-avatar">TI</div>
                                    <div class="client-info">
                                        <strong>TechStart Inc</strong>
                                        <span>billing@techstart.io</span>
                                    </div>
                                </div>
                            </td>
                            <td style="color: var(--text-secondary);">Nov 2, 2026</td>
                            <td class="amount">$2,750.00</td>
                            <td><span class="status-badge status-pending"><span class="status-dot"></span>Pending</span></td>
                            <td><a class="action-link">View</a></td>
                        </tr>
                        <tr>
                            <td style="font-weight: 500;">#INV-2024-0890</td>
                            <td>
                                <div class="client-cell">
                                    <div class="client-avatar">GS</div>
                                    <div class="client-info">
                                        <strong>Global Systems</strong>
                                        <span>accounts@globalsys.com</span>
                                    </div>
                                </div>
                            </td>
                            <td style="color: var(--text-secondary);">Oct 28, 2026</td>
                            <td class="amount">$8,200.00</td>
                            <td><span class="status-badge status-overdue"><span class="status-dot"></span>Overdue</span></td>
                            <td><a class="action-link">Remind</a></td>
                        </tr>
                        <tr>
                            <td style="font-weight: 500;">#INV-2024-0889</td>
                            <td>
                                <div class="client-cell">
                                    <div class="client-avatar">NX</div>
                                    <div class="client-info">
                                        <strong>Nexus Digital</strong>
                                        <span>finance@nexusdigital.co</span>
                                    </div>
                                </div>
                            </td>
                            <td style="color: var(--text-secondary);">Oct 25, 2026</td>
                            <td class="amount">$3,150.00</td>
                            <td><span class="status-badge status-paid"><span class="status-dot"></span>Paid</span></td>
                            <td><a class="action-link">View</a></td>
                        </tr>
                        <tr>
                            <td style="font-weight: 500;">#INV-2024-0888</td>
                            <td>
                                <div class="client-cell">
                                    <div class="client-avatar">VP</div>
                                    <div class="client-info">
                                        <strong>Vertex Partners</strong>
                                        <span>ap@vertexpartners.com</span>
                                    </div>
                                </div>
                            </td>
                            <td style="color: var(--text-secondary);">Oct 22, 2026</td>
                            <td class="amount">$6,800.00</td>
                            <td><span class="status-badge status-pending"><span class="status-dot"></span>Pending</span></td>
                            <td><a class="action-link">View</a></td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </main>
    </div>

    <script>
        // Auth Logic
        const API_KEY_STORAGE = 'shieldinvoice_api_key';
        const VALID_KEY_PREFIX = 'sk_live_';

        function checkAuth() {
            const storedKey = localStorage.getItem(API_KEY_STORAGE);
            if (storedKey && storedKey.startsWith(VALID_KEY_PREFIX)) {
                showDashboard();
            } else {
                showLogin();
            }
        }

        function showLogin() {
            document.getElementById('login-screen').style.display = 'flex';
            document.getElementById('app').classList.remove('active');
        }

        function showDashboard() {
            const loginScreen = document.getElementById('login-screen');
            loginScreen.style.opacity = '0';
            setTimeout(() => {
                loginScreen.style.display = 'none';
                document.getElementById('app').classList.add('active');
            }, 300);
        }

        document.getElementById('login-form').addEventListener('submit', function(e) {
            e.preventDefault();
            const keyInput = document.getElementById('api-key');
            const errorDiv = document.getElementById('login-error');
            const key = keyInput.value.trim();

            if (!key.startsWith(VALID_KEY_PREFIX) || key.length < 20) {
                errorDiv.textContent = 'Invalid API key format. Must start with sk_live_';
                return;
            }

            localStorage.setItem(API_KEY_STORAGE, key);
            errorDiv.textContent = '';
            showDashboard();
        });

        function logout() {
            localStorage.removeItem(API_KEY_STORAGE);
            location.reload();
        }

        // Sidebar Toggle (Mobile)
        function toggleSidebar() {
            document.getElementById('sidebar').classList.toggle('open');
        }

        // Quick Create Invoice (Mock)
        function createInvoice() {
            alert('Quick Create Invoice modal would open here.\\n\\nThis is a demo — backend integration required for production.');
        }

        // Nav Active State
        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', function(e) {
                e.preventDefault();
                document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
                this.classList.add('active');
                
                // Close mobile sidebar on nav
                if (window.innerWidth <= 1024) {
                    document.getElementById('sidebar').classList.remove('open');
                }
            });
        });

        // Initialize
        checkAuth();
    </script>

<script>
// Real backend integration
const SERVICE_API = '/api/shieldinvoice-api';
const API_KEY_STORAGE = 'shieldinvoice_api_key';

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
      'Cache-Control': 'no-cache, must-revalidate',
    },
  });
}
