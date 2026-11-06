(function () {
  'use strict';

  var STATUS_ENDPOINT = 'data/connection-manifest.json';
  var SNAPSHOT_ENDPOINT = '/api/bi/snapshot';
  var state = { mode: 'loading', manifest: null, snapshot: null, error: null };
  var DATA_PAGES = new Set([
    'overview', 'revenue', 'accounts', 'pipeline', 'affiliates', 'competitors',
    'pricing', 'rebuy', 'updates', 'ltv', 'client-profit', 'journey',
    'profitable-risk', 'risk-radar', 'payout-exposure', 'payout-consistency', 'reports', 'settings'
  ]);

  function replaceArray(target, source) {
    if (!Array.isArray(target) || !Array.isArray(source)) return false;
    target.length = 0;
    for (var index = 0; index < source.length; index += 5000) {
      target.push.apply(target, source.slice(index, index + 5000));
    }
    return true;
  }

  function validSnapshot(payload) {
    return payload && payload.schemaVersion === 1 && payload.mode === 'production'
      && payload.data && typeof payload.data === 'object'
      && /^\d{4}-\d{2}-\d{2}$/.test(String(payload.asOf || ''));
  }

  function unique(values) {
    return Array.from(new Set(values.filter(function (value) {
      return value != null && value !== '' && value !== 'Unknown';
    })));
  }

  function discardDemoData() {
    if (!window.BIData) return;
    ['orders', 'affiliates', 'customers', 'riskCases'].forEach(function (key) {
      if (Array.isArray(window.BIData[key])) window.BIData[key].length = 0;
    });
    window.BIData.demo = false;
  }

  function rebuildLiveDimensions() {
    var data = window.BIData;
    var rows = data.accounts.concat(data.payouts);
    replaceArray(data.programmes, unique(rows.map(function (row) { return row.programme; })).sort());
    replaceArray(data.countries, unique(rows.map(function (row) { return row.country; })).sort());
    replaceArray(data.channels, unique(rows.map(function (row) { return row.channel; })).sort());
    data.accountSizes = unique(data.accounts.map(function (row) { return Number(row.accountSize) || 0; }))
      .filter(Boolean).sort(function (a, b) { return a - b; });
  }

  function applySnapshot(payload) {
    if (!validSnapshot(payload) || !window.BIData) return false;
    var data = payload.data;
    if (!Array.isArray(data.accounts) || !Array.isArray(data.payouts)) return false;
    discardDemoData();
    replaceArray(window.BIData.accounts, data.accounts);
    replaceArray(window.BIData.payouts, data.payouts);
    ['orders', 'affiliates', 'customers'].forEach(function (key) {
      if (Array.isArray(data[key])) replaceArray(window.BIData[key], data[key]);
    });
    rebuildLiveDimensions();
    window.BIData.asOf = payload.asOf;
    window.BIData.currency = payload.currency || 'USD';
    window.BIData.productionQuality = payload.quality || {};
    state.mode = 'production';
    state.snapshot = payload;
    if (Array.isArray(data.orders) && data.orders.length) {
      var dates = data.orders.filter(function (row) { return row.revenueEligible; })
        .map(function (row) { return row.date; }).filter(Boolean).sort();
      state.ownerEnd = state.ownerEnd || dates[dates.length - 1];
      state.ownerStart = state.ownerStart || state.ownerEnd.slice(0, 7) + '-01';
    }
    window.dispatchEvent(new Event('bi:production-ready'));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return true;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }

  function money(value) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: 'USD', maximumFractionDigits: 0
    }).format(Number(value) || 0);
  }

  function number(value) {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value) || 0);
  }

  function sum(rows, field) {
    return rows.reduce(function (total, row) { return total + (Number(row[field]) || 0); }, 0);
  }

  function liveText(value) {
    return value == null || value === '' ? 'No live data' : String(value);
  }

  function liveHeader(title, count, source) {
    return '<section class="live-source-banner"><div><span class="live-source-kicker">LIVE WAREHOUSE DATA</span>'
      + '<h2>' + escapeHtml(title) + '</h2><p>' + escapeHtml(source) + '</p></div>'
      + '<div class="live-source-count"><strong>' + number(count) + '</strong><span>records loaded</span></div></section>';
  }

  function metric(label, value, note) {
    return '<article class="kpi-card"><div class="kpi-label">' + escapeHtml(label) + '</div>'
      + '<div class="kpi-value">' + escapeHtml(value) + '</div><div class="kpi-note">'
      + escapeHtml(note) + '</div></article>';
  }

  function accountsPage() {
    var rows = state.snapshot.data.accounts || [];
    var active = rows.filter(function (row) { return String(row.status).toLowerCase() === 'active'; });
    var breached = rows.filter(function (row) { return String(row.stage).toLowerCase() === 'breached'; });
    var shown = rows.slice(0, 100);
    return liveHeader('Account Analytics', rows.length, 'trader_scale account warehouse · snapshot ' + state.snapshot.asOf)
      + '<div class="page-kpis">'
      + metric('Accounts', number(rows.length), 'All records returned by the live snapshot')
      + metric('Active', number(active.length), 'Live account status')
      + metric('Current equity', money(sum(rows, 'equity')), 'Sum of warehouse current equity')
      + metric('Breached', number(breached.length), 'Accounts marked breached in the warehouse')
      + '</div><section class="panel"><div class="panel-header"><div><h2 class="panel-title">Live accounts</h2>'
      + '<p class="panel-subtitle">Showing the first ' + number(shown.length) + ' of ' + number(rows.length)
      + ' records. No estimated rules or simulated risk signals.</p></div></div><div class="table-wrap"><table class="data-table">'
      + '<thead><tr><th>Account</th><th>Customer</th><th>Programme</th><th>Stage</th><th>Status</th>'
      + '<th class="numeric">Start balance</th><th class="numeric">Equity</th><th class="numeric">Realized P&amp;L</th></tr></thead><tbody>'
      + shown.map(function (row) {
        return '<tr><td>' + escapeHtml(row.login || row.id) + '</td><td>' + escapeHtml(row.customerName) + '</td>'
          + '<td>' + escapeHtml(row.programme) + '</td><td>' + escapeHtml(row.stage) + '</td><td>' + escapeHtml(row.status) + '</td>'
          + '<td class="numeric">' + money(row.initialBalance) + '</td><td class="numeric">' + money(row.equity) + '</td>'
          + '<td class="numeric">' + money(row.realizedPnl) + '</td></tr>';
      }).join('') + '</tbody></table></div></section>';
  }

  function payoutsPage() {
    var rows = state.snapshot.data.payouts || [];
    var paid = rows.filter(function (row) { return String(row.status).toLowerCase() === 'paid'; });
    var approved = rows.filter(function (row) { return String(row.status).toLowerCase() === 'approved'; });
    var shown = rows.slice(0, 100);
    return liveHeader('Payouts', rows.length, 'trader_scale payout warehouse · snapshot ' + state.snapshot.asOf)
      + '<div class="page-kpis">'
      + metric('Payout records', number(rows.length), 'All records returned by the live snapshot')
      + metric('Total amount', money(sum(rows, 'amount')), 'All live payout statuses')
      + metric('Paid amount', money(sum(paid, 'amount')), number(paid.length) + ' paid records')
      + metric('Approved amount', money(sum(approved, 'amount')), number(approved.length) + ' approved records')
      + '</div><section class="panel"><div class="panel-header"><div><h2 class="panel-title">Live payout records</h2>'
      + '<p class="panel-subtitle">Showing the first ' + number(shown.length) + ' of ' + number(rows.length)
      + ' records. Revenue ratios are omitted because live sales are not connected.</p></div></div><div class="table-wrap"><table class="data-table">'
      + '<thead><tr><th>Request</th><th>Requested</th><th>Customer</th><th>Account</th><th>Programme</th>'
      + '<th>Status</th><th class="numeric">Amount</th></tr></thead><tbody>'
      + shown.map(function (row) {
        return '<tr><td>' + escapeHtml(row.id) + '</td><td>' + escapeHtml(String(row.requestedAt || '').slice(0, 10)) + '</td>'
          + '<td>' + escapeHtml(row.customerName) + '</td><td>' + escapeHtml(row.account) + '</td>'
          + '<td>' + escapeHtml(row.programme) + '</td><td>' + escapeHtml(row.status) + '</td>'
          + '<td class="numeric">' + money(row.amount) + '</td></tr>';
      }).join('') + '</tbody></table></div></section>';
  }

  function ownerOverviewPage() {
    var all = (state.snapshot.data.orders || []).filter(function (row) { return row.revenueEligible; });
    var start = state.ownerStart || '';
    var end = state.ownerEnd || '';
    var rows = all.filter(function (row) { return row.date >= start && row.date <= end; });
    var customers = new Set(rows.map(function (row) { return row.customerId; }).filter(Boolean));
    var newCustomers = new Set(rows.filter(function (row) { return row.isNewCustomer; }).map(function (row) { return row.customerId; }));
    var daily = {};
    rows.forEach(function (row) {
      if (!daily[row.date]) daily[row.date] = { date: row.date, orders: 0, grossRevenue: 0, refunded: 0, netRevenue: 0 };
      daily[row.date].orders += 1;
      daily[row.date].grossRevenue += Number(row.grossRevenue) || 0;
      daily[row.date].refunded += Number(row.refunded) || 0;
      daily[row.date].netRevenue += Number(row.netRevenue) || 0;
    });
    var days = Object.keys(daily).sort().reverse().map(function (key) { return daily[key]; });
    return liveHeader('Owner overview', rows.length, 'Canonical eligible orders · UTC · USD')
      + '<section class="live-range"><label>From <input type="date" id="owner-live-start" value="' + escapeHtml(start) + '"></label>'
      + '<label>To <input type="date" id="owner-live-end" value="' + escapeHtml(end) + '"></label>'
      + '<button class="btn btn-primary" data-production-action="apply-owner-range">Apply</button></section>'
      + '<div class="page-kpis">'
      + metric('Net revenue', money(sum(rows, 'netRevenue')), 'Gross revenue less linked refunds')
      + metric('Gross revenue', money(sum(rows, 'grossRevenue')), number(rows.length) + ' eligible orders')
      + metric('Paying customers', number(customers.size), 'Distinct canonical commerce customers')
      + metric('New / existing', number(newCustomers.size) + ' / ' + number(Math.max(0, customers.size - newCustomers.size)), 'Based on first-ever eligible order')
      + '</div><section class="panel"><div class="panel-header"><div><h2 class="panel-title">Daily revenue</h2>'
      + '<p class="panel-subtitle">' + escapeHtml(start) + ' – ' + escapeHtml(end) + ' · fct_commerce_orders</p></div></div>'
      + '<div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th class="numeric">Orders</th>'
      + '<th class="numeric">Gross revenue</th><th class="numeric">Refunded</th><th class="numeric">Net revenue</th></tr></thead><tbody>'
      + days.map(function (row) { return '<tr><td>' + escapeHtml(row.date) + '</td><td class="numeric">' + number(row.orders)
        + '</td><td class="numeric">' + money(row.grossRevenue) + '</td><td class="numeric">' + money(row.refunded)
        + '</td><td class="numeric"><strong>' + money(row.netRevenue) + '</strong></td></tr>'; }).join('')
      + (days.length ? '' : '<tr><td colspan="5">No live data for this date range.</td></tr>')
      + '</tbody></table></div></section>';
  }

  function profitabilityPage() {
    var rows = state.snapshot.data.profitability || [];
    return liveHeader('Profitability', rows.length, 'Attempt-grain account_profitability · all available history')
      + '<div class="page-kpis">'
      + metric('Revenue', money(sum(rows, 'revenue')), number(sum(rows, 'attempts')) + ' attempts')
      + metric('Approved payouts', money(sum(rows, 'payouts')), number(sum(rows, 'payoutCount')) + ' payouts')
      + metric('Gross profit', money(sum(rows, 'grossProfit')), 'Revenue less approved trader payouts')
      + metric('Payout / revenue', sum(rows, 'revenue') ? (sum(rows, 'payouts') / sum(rows, 'revenue') * 100).toFixed(1) + '%' : 'No live data', 'Attempt-grain ratio')
      + '</div><section class="panel"><div class="panel-header"><div><h2 class="panel-title">Profitability by programme and size</h2>'
      + '<p class="panel-subtitle">No PSP, platform, commission or overhead estimates are added.</p></div></div><div class="table-wrap">'
      + '<table class="data-table"><thead><tr><th>Programme</th><th class="numeric">Account size</th><th class="numeric">Attempts</th>'
      + '<th class="numeric">Revenue</th><th class="numeric">Payouts</th><th class="numeric">Gross profit</th></tr></thead><tbody>'
      + rows.map(function (row) { return '<tr><td>' + escapeHtml(liveText(row.programme)) + '</td><td class="numeric">' + money(row.accountSize)
        + '</td><td class="numeric">' + number(row.attempts) + '</td><td class="numeric">' + money(row.revenue)
        + '</td><td class="numeric">' + money(row.payouts) + '</td><td class="numeric"><strong>' + money(row.grossProfit) + '</strong></td></tr>'; }).join('')
      + '</tbody></table></div></section>';
  }

  function affiliatesPage() {
    var rows = state.snapshot.data.affiliates || [];
    return liveHeader('Affiliates', rows.length, 'Canonical order attribution · all eligible orders')
      + '<div class="page-kpis">' + metric('Attributed net revenue', money(sum(rows.filter(function (r) { return r.status === 'attributed'; }), 'netRevenue')), 'Production v6 attribution')
      + metric('Affiliate orders', number(sum(rows.filter(function (r) { return r.status === 'attributed'; }), 'orders')), 'Attributed eligible orders')
      + metric('New customers', number(sum(rows.filter(function (r) { return r.status === 'attributed'; }), 'newCustomers')), 'First-ever canonical orders')
      + metric('Conflicts retained', number(sum(rows, 'conflictOrders')), 'Attribution evidence conflicts') + '</div>'
      + '<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Affiliate performance</h2>'
      + '<p class="panel-subtitle">fct_affiliate_order_attribution joined at canonical order grain.</p></div></div><div class="table-wrap">'
      + '<table class="data-table"><thead><tr><th>Affiliate</th><th>Status</th><th class="numeric">Orders</th><th class="numeric">Customers</th>'
      + '<th class="numeric">New customers</th><th class="numeric">Net revenue</th></tr></thead><tbody>'
      + rows.map(function (row) { return '<tr><td>' + escapeHtml(liveText(row.name)) + '</td><td>' + escapeHtml(liveText(row.status))
        + '</td><td class="numeric">' + number(row.orders) + '</td><td class="numeric">' + number(row.customers)
        + '</td><td class="numeric">' + number(row.newCustomers) + '</td><td class="numeric"><strong>' + money(row.netRevenue) + '</strong></td></tr>'; }).join('')
      + '</tbody></table></div></section>';
  }

  function customersPage() {
    var rows = state.snapshot.data.customers || [];
    var shown = rows.slice(0, 200);
    return liveHeader('Customer value', rows.length, 'Canonical commerce customers · live rollups')
      + '<div class="page-kpis">' + metric('Commerce customers', number(rows.length), 'Registered, matched, guest and anonymous identities')
      + metric('Customer revenue', money(sum(rows, 'revenue')), 'Canonical eligible-order revenue')
      + metric('Completed orders', number(sum(rows, 'completedOrderCount')), 'Commerce customer rollup')
      + metric('KYC verified', number(rows.filter(function (row) { return row.kycVerified; }).length), 'Live customer profile flag') + '</div>'
      + '<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Live customer value</h2>'
      + '<p class="panel-subtitle">Showing the first ' + number(shown.length) + ' by revenue. Restricted email, phone and address fields are not loaded.</p></div></div>'
      + '<div class="table-wrap"><table class="data-table"><thead><tr><th>Customer</th><th>Country</th><th>Status</th>'
      + '<th class="numeric">Accounts</th><th class="numeric">Orders</th><th class="numeric">Revenue</th><th>Last order</th></tr></thead><tbody>'
      + shown.map(function (row) { return '<tr><td>' + escapeHtml(liveText(row.name)) + '</td><td>' + escapeHtml(liveText(row.country))
        + '</td><td>' + escapeHtml(liveText(row.status)) + '</td><td class="numeric">' + number(row.accountCount)
        + '</td><td class="numeric">' + number(row.completedOrderCount) + '</td><td class="numeric"><strong>' + money(row.revenue)
        + '</strong></td><td>' + escapeHtml(liveText(row.lastOrderAt)) + '</td></tr>'; }).join('') + '</tbody></table></div></section>';
  }

  function noLiveDataPage(page) {
    var labels = {
      overview: 'Owner overview', revenue: 'Profitability', affiliates: 'Affiliates',
      competitors: 'Competitor analysis', pricing: 'Pricing & profitability', rebuy: 'Average rebuy time',
      updates: 'Updates & impact', ltv: 'Customer lifetime value', 'client-profit': 'Client lifetime profit',
      journey: 'Customer journey', 'profitable-risk': 'High-risk clients in profit',
      'risk-radar': 'Risk radar', 'payout-exposure': 'Payout exposure patterns',
      'payout-consistency': 'Consistency score distribution', reports: 'Reports'
    };
    return '<section class="no-live-data"><span class="no-live-icon">—</span><p class="no-live-kicker">LIVE SOURCE NOT CONNECTED</p>'
      + '<h2>No live data</h2><p>' + escapeHtml(labels[page] || 'This report')
      + ' is hidden until its production dataset is connected and validated.</p>'
      + '<small>No demo, sample, generated, estimated or fallback values are displayed.</small></section>';
  }

  function healthPage() {
    var screens = state.manifest && state.manifest.screens ? state.manifest.screens : {};
    var warnings = state.snapshot && state.snapshot.quality && state.snapshot.quality.warnings || [];
    return '<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Production data coverage</h2>'
      + '<p class="panel-subtitle">Only validated live datasets are allowed to display values.</p></div></div><div class="connection-list">'
      + Object.keys(screens).map(function (key) {
        var item = screens[key];
        var live = item.state === 'live';
        return '<div class="connection-row"><span class="connection-icon">' + (live ? '●' : '—') + '</span>'
          + '<div class="connection-text"><strong>' + escapeHtml(item.label) + '</strong><span>'
          + escapeHtml((item.sources || []).join(' · ')) + '</span></div><span class="badge badge-'
          + (live ? 'success' : 'neutral') + '">' + (live ? 'LIVE' : 'NO LIVE DATA') + '</span></div>';
      }).join('') + '</div></section>'
      + '<section class="panel" style="margin-top:18px"><div class="panel-header"><div><h2 class="panel-title">Warehouse checks</h2>'
      + '<p class="panel-subtitle">Current snapshot messages.</p></div></div><div class="panel-body">'
      + warnings.map(function (warning) { return '<p>' + escapeHtml(warning) + '</p>'; }).join('') + '</div></section>';
  }

  function settingsPage() {
    return '<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Production workspace</h2>'
      + '<p class="panel-subtitle">Live-only display policy is active.</p></div><span class="badge badge-success">LIVE ONLY</span></div>'
      + '<div class="settings-list"><div class="setting-row"><div><strong>Demo and fallback data</strong>'
      + '<p>Generated, sample and fallback business values are disabled.</p></div><span class="badge badge-neutral">OFF</span></div>'
      + '<div class="setting-row"><div><strong>Missing datasets</strong><p>Screens without validated production sources display No live data.</p>'
      + '</div><span class="badge badge-neutral">STRICT</span></div><div class="setting-row"><div><strong>Currency</strong>'
      + '<p>Live monetary values are displayed in US dollars.</p></div><span class="badge badge-neutral">USD</span></div></div></section>';
  }

  function loadingPage() {
    return '<section class="no-live-data"><p class="no-live-kicker">WAREHOUSE CONNECTION</p>'
      + '<h2>' + (state.mode === 'error' ? 'No live data' : 'Loading live data…') + '</h2><p>'
      + (state.mode === 'error' ? 'The live snapshot could not be loaded. No fallback data is displayed.' : 'Waiting for the production snapshot.')
      + '</p></section>';
  }

  function currentPage() {
    var value = location.hash.slice(1) || 'overview';
    if (value === 'payouts') return 'pipeline';
    if (value === 'risk' || value === 'account-review') return 'accounts';
    return value;
  }

  function hideLegacyControls(page) {
    var filters = document.getElementById('filters-row');
    var actions = document.querySelector('.heading-actions');
    if (filters) filters.hidden = true;
    if (actions) actions.hidden = true;
    var description = document.getElementById('page-description');
    var eyebrow = document.getElementById('eyebrow');
    if (eyebrow) eyebrow.textContent = state.mode === 'production' ? 'LIVE WAREHOUSE' : 'WAREHOUSE CONNECTION';
    if (description) {
      description.textContent = page === 'accounts'
        ? 'Validated account records from the production warehouse.'
        : page === 'pipeline'
          ? 'Validated payout records from the production warehouse.'
          : 'This screen displays values only when a validated live source is connected.';
    }
  }

  function enforceProductionView() {
    var page = currentPage();
    var content = document.getElementById('page-content');
    if (!content || (!DATA_PAGES.has(page) && page !== 'health')) return;
    var viewKey = state.mode + ':' + page + ':' + (state.snapshot ? state.snapshot.asOf : '')
      + ':' + (state.ownerStart || '') + ':' + (state.ownerEnd || '');
    if (content.getAttribute('data-production-view') === viewKey
        && content.querySelector(':scope > [data-production-root]')) return;
    hideLegacyControls(page);
    if (state.mode !== 'production') content.innerHTML = loadingPage();
    else if (page === 'overview' && state.snapshot.quality.revenueReady) content.innerHTML = ownerOverviewPage();
    else if (page === 'revenue' && state.snapshot.quality.profitabilityReady) content.innerHTML = profitabilityPage();
    else if (page === 'affiliates' && state.snapshot.quality.affiliatesReady) content.innerHTML = affiliatesPage();
    else if (page === 'ltv' && state.snapshot.quality.customersReady) content.innerHTML = customersPage();
    else if (page === 'accounts') content.innerHTML = accountsPage();
    else if (page === 'pipeline') content.innerHTML = payoutsPage();
    else if (page === 'health') content.innerHTML = healthPage();
    else if (page === 'settings') content.innerHTML = settingsPage();
    else content.innerHTML = noLiveDataPage(page);
    content.setAttribute('data-production-view', viewKey);
    if (content.firstElementChild) content.firstElementChild.setAttribute('data-production-root', '');
  }

  function decorateBadge() {
    var badge = document.querySelector('.demo-badge');
    if (!badge) return;
    var sidebarVersion = document.querySelector('.sidebar-version');
    var footerCopy = document.querySelector('.workspace-footer > span');
    if (sidebarVersion) sidebarVersion.innerHTML = '<span class="version-dot"></span> Production warehouse';
    if (footerCopy) footerCopy.textContent = 'TraderScale BI / Live warehouse data only.';
    if (state.mode === 'production') {
      badge.textContent = 'LIVE DATA';
      badge.title = 'Only connected production datasets are displayed.';
    } else if (state.mode === 'error') {
      badge.textContent = 'NO LIVE DATA';
      badge.title = 'The warehouse snapshot is unavailable. No fallback data is displayed.';
    } else {
      badge.textContent = 'LOADING LIVE';
      badge.title = 'Waiting for the production snapshot.';
    }
    badge.removeAttribute('data-action');
    var notification = document.querySelector('.notification-button');
    if (notification) notification.hidden = true;
    document.querySelectorAll('.workspace-footer [data-action="about"]').forEach(function (button) {
      button.hidden = true;
    });
    var profileName = document.querySelector('.profile-name');
    var profileRole = document.querySelector('.profile-role');
    if (profileName) profileName.textContent = 'TraderScale';
    if (profileRole) profileRole.textContent = 'Production workspace';
  }

  function injectStyles() {
    if (document.getElementById('production-only-styles')) return;
    var style = document.createElement('style');
    style.id = 'production-only-styles';
    style.textContent = '.live-source-banner{display:flex;justify-content:space-between;align-items:center;gap:24px;padding:22px 24px;margin-bottom:18px;border:1px solid #dce9e3;border-radius:9px;background:#f8fcfa}.live-source-kicker,.no-live-kicker{display:block;font-size:9px;font-weight:700;letter-spacing:1.2px;color:#3f8b69}.live-source-banner h2{margin:7px 0 5px;font-size:20px}.live-source-banner p{margin:0;color:#7b8793;font-size:10px}.live-source-count{text-align:right}.live-source-count strong{display:block;font-size:25px}.live-source-count span{font-size:9px;color:#7b8793}.live-range{display:flex;align-items:end;gap:12px;padding:16px 18px;margin-bottom:18px;border:1px solid #e2e7eb;border-radius:8px;background:#fff}.live-range label{display:flex;flex-direction:column;gap:6px;font-size:10px;color:#74808b}.live-range input{height:35px;border:1px solid #d7dfe5;border-radius:6px;padding:0 9px;color:#425466}.live-range .btn{height:35px}.no-live-data{min-height:360px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:48px 24px;border:1px solid #e2e6ea;border-radius:10px;background:#fff}.no-live-icon{display:grid;place-items:center;width:44px;height:44px;border-radius:50%;background:#f2f4f6;color:#8b96a1;font-size:22px;margin-bottom:18px}.no-live-data h2{font-size:26px;margin:9px 0 10px}.no-live-data p:not(.no-live-kicker){max-width:520px;margin:0;color:#75818c;line-height:1.7}.no-live-data small{margin-top:14px;color:#9aa3ab}.demo-badge{border-color:#bcdcca!important;background:#f5fbf7!important;color:#337d5d!important}.demo-badge:before{background:#42a477!important}@media(max-width:720px){.live-source-banner{align-items:flex-start}.live-source-count{display:none}.live-range{align-items:stretch;flex-direction:column}}';
    document.head.appendChild(style);
  }

  function refreshPresentation() {
    injectStyles();
    decorateBadge();
    enforceProductionView();
  }

  async function start() {
    discardDemoData();
    refreshPresentation();
    try {
      var manifestResponse = await fetch(STATUS_ENDPOINT, { cache: 'no-store' });
      if (manifestResponse.ok) state.manifest = await manifestResponse.json();
    } catch (error) {
      state.error = error;
    }
    try {
      var response = await fetch(SNAPSHOT_ENDPOINT, { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok || !applySnapshot(await response.json())) throw new Error('Invalid live snapshot.');
    } catch (error) {
      state.error = error;
      state.mode = 'error';
    }
    refreshPresentation();
  }

  window.BIProductionConnector = { state: state, applySnapshot: applySnapshot, start: start };
  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-production-action="apply-owner-range"]');
    if (!button) return;
    var start = document.getElementById('owner-live-start');
    var end = document.getElementById('owner-live-end');
    if (!start || !end || !start.value || !end.value || start.value > end.value) return;
    state.ownerStart = start.value;
    state.ownerEnd = end.value;
    enforceProductionView();
  });
  window.addEventListener('hashchange', function () { setTimeout(refreshPresentation, 0); });
  var refreshScheduled = false;
  new MutationObserver(function () {
    if (refreshScheduled) return;
    refreshScheduled = true;
    setTimeout(function () {
      refreshScheduled = false;
      refreshPresentation();
    }, 0);
  }).observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
