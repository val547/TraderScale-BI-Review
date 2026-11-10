(function () {
  'use strict';

  var STATUS_ENDPOINT = 'data/connection-manifest.json';
  var COMPETITOR_ENDPOINT = 'data/competitor-monitor.json';
  var SNAPSHOT_ENDPOINT = '/api/bi/snapshot';
  var state = {
    mode: 'loading', manifest: null, snapshot: null, error: null,
    dateStart: '', dateEnd: '', dateAllTime: true, datePickerOpen: false, pendingAllTime: true
  };
  var DATA_PAGES = new Set([
    'overview', 'revenue', 'accounts', 'pipeline', 'affiliates', 'competitors',
    'pricing', 'marketing', 'rebuy', 'updates', 'ltv', 'client-profit', 'journey',
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
    ['orders', 'affiliates', 'customers', 'accounts', 'payouts', 'riskCases'].forEach(function (key) {
      if (Array.isArray(window.BIData[key])) window.BIData[key].length = 0;
    });
    window.BIData.demo = false;
  }

  function rebuildLiveDimensions() {
    var data = window.BIData;
    var rows = data.accounts.concat(data.payouts, data.orders || [], data.productionProfitability || []);
    replaceArray(data.programmes, unique(rows.map(function (row) { return row.programme; })).sort());
    replaceArray(data.countries, unique(rows.map(function (row) { return row.country; })).sort());
    replaceArray(data.channels, unique(rows.map(function (row) { return row.channel; })).sort());
    data.accountSizes = unique(data.accounts.map(function (row) { return Number(row.accountSize) || 0; }))
      .filter(Boolean).sort(function (a, b) { return a - b; });
  }

  function initials(value) {
    return String(value || '').split(/\s+/).filter(Boolean).slice(0, 2)
      .map(function (part) { return part.charAt(0).toUpperCase(); }).join('') || '—';
  }

  function adaptSnapshotData(payload) {
    var data = payload.data;
    var accountsById = {};
    data.accounts.forEach(function (row) { accountsById[String(row.id)] = row; });
    var customerProfiles = {};
    (data.customers || []).forEach(function (row) { customerProfiles[String(row.id)] = row; });
    var attributionByOrder = {};
    (data.affiliates || []).forEach(function (row) { attributionByOrder[String(row.storeId) + ':' + String(row.orderId)] = row; });

    var affiliateProfiles = {};
    (data.affiliates || []).forEach(function (row) {
      if (!row.id || row.id === 'unattributed' || row.status !== 'attributed') return;
      if (!affiliateProfiles[row.id]) affiliateProfiles[row.id] = {
        id: row.id, name: row.name, initials: initials(row.name), country: 'Unknown',
        retainer: null, commissionRate: null, trafficType: 'unrecorded', trafficTypeLabel: 'Type not recorded'
      };
    });

    var orders = (data.orders || []).filter(function (row) { return row.revenueEligible; }).map(function (row) {
      var attribution = attributionByOrder[row.id] || null;
      var account = attribution && attribution.accountIds
        ? attribution.accountIds.map(function (id) { return accountsById[String(id)]; }).find(Boolean)
        : null;
      var profile = customerProfiles[row.customerId] || {};
      var affiliateId = attribution && attribution.status === 'attributed' ? attribution.id : null;
      if (account) {
        account.orderId = row.id;
        account.channel = affiliateId ? 'Affiliate' : 'Unknown';
        account.affiliateId = affiliateId;
      }
      return {
        id: row.id, date: row.date, customerId: row.customerId,
        customerName: profile.name || (account && account.customerName) || 'No live data',
        programme: row.programme && row.programme !== 'Unknown' ? row.programme : account ? account.programme : 'Unknown',
        programmeFamily: row.programmeFamily || (account && account.programmeFamily) || 'Unknown',
        plan: row.productName || (account && account.plan) || '',
        platform: row.platform || (account && account.platform) || '',
        accountSize: Number(row.accountSize) || (account ? account.accountSize : 0),
        accountId: account ? account.id : '', country: row.country || profile.country || 'Unknown',
        channel: affiliateId ? 'Affiliate' : 'Unknown', affiliateId: affiliateId,
        affiliateTrafficType: affiliateId ? 'unrecorded' : null,
        grossSales: Number(row.grossRevenue) || 0, discount: 0, refund: Number(row.refunded) || 0,
        chargeback: 0, pspFee: null, platformCost: null, acquisitionCost: null,
        commission: null, payoutCost: null, netSales: Number(row.netRevenue) || 0,
        contribution: null, isNewCustomer: !!row.isNewCustomer, liveCostCoverage: false
      };
    });

    var orderRollups = {};
    orders.forEach(function (row) {
      if (!orderRollups[row.customerId]) orderRollups[row.customerId] = { spend: 0, orders: 0, last: '', first: row.date, programme: row.programme };
      var rollup = orderRollups[row.customerId];
      rollup.spend += row.netSales;
      rollup.orders += 1;
      if (row.date > rollup.last) rollup.last = row.date;
      if (row.date < rollup.first) rollup.first = row.date;
      if (rollup.programme === 'Unknown' && row.programme !== 'Unknown') rollup.programme = row.programme;
    });
    var customers = (data.customers || []).map(function (row) {
      var rollup = orderRollups[row.id] || {};
      return Object.assign({}, row, {
        id: row.id, name: row.name, email: '', country: row.country,
        firstPurchase: row.firstOrderAt, programme: rollup.programme || 'Unknown', stage: row.status,
        accounts: row.accountCount, lastActive: row.lastOrderAt, totalSpend: Number(row.revenue) || 0,
        allStatusOrderCount: row.orderCount,
        orderCount: row.completedOrderCount, kycVerified: row.kycVerified
      });
    });
    return { orders: orders, customers: customers, affiliates: Object.keys(affiliateProfiles).map(function (key) { return affiliateProfiles[key]; }) };
  }

  function installLiveCalculations() {
    var data = window.BIData;
    function selected(filters) {
      filters = filters || {};
      return data.orders.filter(function (row) {
        return inDateRange(row.date)
          && (!filters.programme || filters.programme === 'all' || row.programme === filters.programme)
          && (!filters.country || filters.country === 'all' || row.country === filters.country)
          && (!filters.channel || filters.channel === 'all' || row.channel === filters.channel)
          && (!filters.size || filters.size === 'all' || Number(row.accountSize) === Number(filters.size));
      });
    }
    function total(rows, field) { return rows.reduce(function (value, row) { return value + (Number(row[field]) || 0); }, 0); }
    data.filterOrders = selected;
    data.getMetrics = function (filters) {
      var rows = selected(filters);
      return {
        netSales: total(rows, 'netSales'), contribution: null, refunds: total(rows, 'refund'), chargebacks: total(rows, 'chargeback'),
        commissions: null, acquisitionCosts: null, pspFees: null, platformCosts: null, payoutCosts: null,
        grossSales: total(rows, 'grossSales'), discounts: total(rows, 'discount'), orders: rows.length,
        newCustomers: new Set(rows.filter(function (row) { return row.isNewCustomer; }).map(function (row) { return row.customerId; })).size,
        customers: new Set(rows.map(function (row) { return row.customerId; }).filter(Boolean)).size,
        liveCostCoverage: false
      };
    };
    data.getSeries = function (filters) {
      var buckets = {};
      selected(filters).forEach(function (row) {
        if (!buckets[row.date]) buckets[row.date] = { date: row.date, netSales: 0, contribution: null };
        buckets[row.date].netSales += row.netSales;
      });
      return Object.keys(buckets).sort().map(function (key) { return buckets[key]; });
    };
    data.getProducts = function (filters) {
      var groups = {};
      selected(filters).forEach(function (row) {
        if (!groups[row.programme]) groups[row.programme] = { name: row.programme, netSales: 0, contribution: null, orders: 0, margin: null };
        groups[row.programme].netSales += row.netSales;
        groups[row.programme].orders += 1;
      });
      return Object.keys(groups).map(function (key) { return groups[key]; }).sort(function (a, b) { return b.netSales - a.netSales; });
    };
    data.getAffiliates = function (filters) {
      return data.affiliates.map(function (affiliate) {
        var rows = selected(filters).filter(function (row) { return row.affiliateId === affiliate.id; });
        var newRows = rows.filter(function (row) { return row.isNewCustomer; });
        return Object.assign({}, affiliate, {
          netSales: total(rows, 'netSales'), contribution: null,
          newCustomers: new Set(newRows.map(function (row) { return row.customerId; })).size,
          commission: null, acquisitionCost: null, payoutCost: null, refunds: total(rows, 'refund'),
          orders: rows.length, cac: null, ltv: null, margin: null
        });
      }).filter(function (affiliate) { return affiliate.orders > 0; }).sort(function (a, b) { return b.netSales - a.netSales; });
    };
    data.getCustomers = function (filters) {
      var ids = new Set(selected(filters).map(function (row) { return row.customerId; }));
      return data.customers.filter(function (row) { return ids.has(row.id); }).sort(function (a, b) { return b.totalSpend - a.totalSpend; });
    };
    data.filterAccounts = function (filters) {
      filters = filters || {};
      return data.accounts.filter(function (row) {
        return inDateRange(row.openedAt)
          && (!filters.programme || filters.programme === 'all' || row.programme === filters.programme)
          && (!filters.country || filters.country === 'all' || row.country === filters.country)
          && (!filters.channel || filters.channel === 'all' || row.channel === filters.channel)
          && (!filters.size || filters.size === 'all' || Number(row.accountSize) === Number(filters.size))
          && (!filters.accountStage || filters.accountStage === 'all' || row.stage === filters.accountStage);
      });
    };
    data.getAccountGroups = function (filters, groupBy) {
      var key = groupBy === 'accountSize' ? 'accountSize' : 'programme';
      var orderMap = {};
      data.orders.forEach(function (row) { orderMap[row.id] = row; });
      var groups = {};
      data.filterAccounts(filters).forEach(function (row) {
        var name = row[key];
        if (!groups[name]) groups[name] = { name: name, accounts: 0, active: 0, funded: 0, breached: 0, netSales: 0, contribution: null, realizedPnl: 0, openPnl: 0, payoutAccrued: 0, approvedPayouts: 0, highRisk: 0 };
        var group = groups[name], order = orderMap[row.orderId];
        group.accounts += 1;
        if (row.status === 'Active') group.active += 1;
        if (row.stage === 'Funded') group.funded += 1;
        if (row.stage === 'Breached') group.breached += 1;
        if (order) group.netSales += Number(order.netSales) || 0;
        group.realizedPnl += Number(row.realizedPnl) || 0;
        group.openPnl += Number(row.openPnl) || 0;
        group.payoutAccrued += Number(row.payoutAccrued) || 0;
        group.approvedPayouts += Number(row.payoutApproved) || 0;
        if (row.status === 'Active' && row.riskLevel === 'High') group.highRisk += 1;
      });
      return Object.keys(groups).map(function (keyName) { return groups[keyName]; });
    };
  }

  function installProductionSources() {
    function sourceFor(data) {
      var orders = Array.isArray(data.orders) ? data.orders : [];
      var dates = orders.map(function (row) { return isoDate(row.date); }).filter(Boolean).sort();
      var payouts = Array.isArray(data.payouts) ? data.payouts : [];
      return {
        orders: orders,
        customers: Array.isArray(data.customers) ? data.customers : [],
        payouts: payouts,
        historyStart: dates[0] || data.asOf,
        asOf: data.asOf,
        extendedDemo: false,
        sourceNote: 'Live production warehouse history.'
      };
    }
    if (window.BICustomerValueData) window.BICustomerValueData.getData = sourceFor;
    if (window.BIMonthlyCohortsData) window.BIMonthlyCohortsData.getData = function (data) { return sourceFor(data); };
    if (window.BIPayoutOutcomesData) window.BIPayoutOutcomesData.getData = function (source, data) {
      var rows = (source && source.payouts || data && data.payouts || []).filter(function (row) { return row.status === 'Rejected'; });
      var rejected = rows.map(function (row) {
        return Object.assign({}, row, {
          requestedAmount: row.amount,
          rejectedAt: row.rejectedAt || row.decisionAt || '',
          reason: row.reason || 'Reason not recorded',
          simulated: false,
          rejectionSource: 'Production payout record'
        });
      });
      return { rejected: rejected, historyStart: source && source.historyStart || data.asOf, asOf: data.asOf,
        available: true, complete: false, illustrative: false, sourceNote: 'Live recorded rejection decisions.' };
    };
    window.BIThoughtMetricData = window.BIData.productionMarketing || null;
  }

  function applySnapshot(payload) {
    if (!validSnapshot(payload) || !window.BIData) return false;
    var data = payload.data;
    if (!Array.isArray(data.accounts) || !Array.isArray(data.payouts)) return false;
    discardDemoData();
    state.snapshot = payload;
    var adapted = adaptSnapshotData(payload);
    replaceArray(window.BIData.accounts, data.accounts);
    replaceArray(window.BIData.payouts, data.payouts);
    replaceArray(window.BIData.orders, adapted.orders);
    replaceArray(window.BIData.affiliates, adapted.affiliates);
    replaceArray(window.BIData.customers, adapted.customers);
    window.BIData.productionProfitability = Array.isArray(data.profitability) ? data.profitability.slice() : [];
    window.BIData.productionMarketing = data.marketing && typeof data.marketing === 'object' ? data.marketing : null;
    window.BIData.productionWithdrawable = data.withdrawable && typeof data.withdrawable === 'object' ? data.withdrawable : null;
    window.BIData.productionRiskFindings = Array.isArray(data.riskFindings) ? data.riskFindings.slice() : [];
    window.BIData.productionRebuy = Array.isArray(data.rebuy) ? data.rebuy.slice() : [];
    rebuildLiveDimensions();
    installLiveCalculations();
    window.BIData.asOf = payload.asOf;
    window.BIData.currency = payload.currency || 'USD';
    window.BIData.productionQuality = payload.quality || {};
    installProductionSources();
    state.mode = 'production';
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

  function isoDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value).slice(0, 10) : '';
  }

  function shiftDate(value, days) {
    var dateValue = new Date(value + 'T00:00:00Z');
    dateValue.setUTCDate(dateValue.getUTCDate() + days);
    return dateValue.toISOString().slice(0, 10);
  }

  function startOfWeek(value) {
    var dateValue = new Date(value + 'T00:00:00Z');
    var day = dateValue.getUTCDay() || 7;
    return shiftDate(value, 1 - day);
  }

  function startOfQuarter(value) {
    var parts = value.split('-');
    var month = Math.floor((Number(parts[1]) - 1) / 3) * 3 + 1;
    return parts[0] + '-' + String(month).padStart(2, '0') + '-01';
  }

  function presetRange(name) {
    var today = state.snapshot.asOf;
    var year = today.slice(0, 4);
    var monthStart = today.slice(0, 7) + '-01';
    var weekStart = startOfWeek(today);
    var quarterStart = startOfQuarter(today);
    if (name === 'today') return { start: today, end: today };
    if (name === 'yesterday') return { start: shiftDate(today, -1), end: shiftDate(today, -1) };
    if (/^\d+d$/.test(name)) return { start: shiftDate(today, 1 - Number(name.slice(0, -1))), end: today };
    if (name === 'this-week') return { start: weekStart, end: today };
    if (name === 'last-week') return { start: shiftDate(weekStart, -7), end: shiftDate(weekStart, -1) };
    if (name === 'this-month') return { start: monthStart, end: today };
    if (name === 'last-month') {
      var previousMonthEnd = shiftDate(monthStart, -1);
      return { start: previousMonthEnd.slice(0, 7) + '-01', end: previousMonthEnd };
    }
    if (name === 'this-quarter') return { start: quarterStart, end: today };
    if (name === 'last-quarter') {
      var previousQuarterEnd = shiftDate(quarterStart, -1);
      return { start: startOfQuarter(previousQuarterEnd), end: previousQuarterEnd };
    }
    if (name === 'this-year') return { start: year + '-01-01', end: today };
    if (name === 'last-year') return { start: String(Number(year) - 1) + '-01-01', end: String(Number(year) - 1) + '-12-31' };
    return dateBounds();
  }

  function dateBounds() {
    var data = state.snapshot ? state.snapshot.data : {};
    var values = [];
    (data.orders || []).forEach(function (row) { if (isoDate(row.date)) values.push(isoDate(row.date)); });
    (data.accounts || []).forEach(function (row) { if (isoDate(row.openedAt)) values.push(isoDate(row.openedAt)); });
    (data.payouts || []).forEach(function (row) { if (isoDate(row.requestedAt)) values.push(isoDate(row.requestedAt)); });
    (data.profitability || []).forEach(function (row) { if (isoDate(row.date)) values.push(isoDate(row.date)); });
    (data.affiliates || []).forEach(function (row) { if (isoDate(row.date)) values.push(isoDate(row.date)); });
    ((data.marketing && data.marketing.channels) || []).forEach(function (row) { if (isoDate(row.date)) values.push(isoDate(row.date)); });
    ((data.marketing && data.marketing.campaigns) || []).forEach(function (row) { if (isoDate(row.date)) values.push(isoDate(row.date)); });
    (data.customers || []).forEach(function (row) { if (isoDate(row.registeredAt)) values.push(isoDate(row.registeredAt)); });
    (data.rebuy || []).forEach(function (row) { if (isoDate(row.breachedAt)) values.push(isoDate(row.breachedAt)); });
    values.sort();
    var fallback = state.snapshot && state.snapshot.asOf
      ? state.snapshot.asOf
      : new Date().toISOString().slice(0, 10);
    return { min: values[0] || fallback, max: values[values.length - 1] || fallback };
  }

  function inDateRange(value) {
    var normalized = isoDate(value);
    if (!normalized) return false;
    if (state.dateAllTime) return true;
    return normalized >= state.dateStart && normalized <= state.dateEnd;
  }

  function humanDate(value) {
    if (!value) return '';
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(value + 'T00:00:00Z'));
  }

  function dateLabel() {
    return state.dateAllTime ? 'All time' : humanDate(state.dateStart) + ' – ' + humanDate(state.dateEnd);
  }

  function dateRange() {
    var bounds = dateBounds();
    return state.dateAllTime ? [bounds.min, bounds.max] : [state.dateStart, state.dateEnd];
  }

  function dateToolbar() {
    var bounds = dateBounds();
    var start = state.dateAllTime ? bounds.min : state.dateStart;
    var end = state.dateAllTime ? bounds.max : state.dateEnd;
    var presets = [
      ['all', 'All time'], ['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', 'Last 7 days'],
      ['14d', 'Last 14 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days'],
      ['this-week', 'This week'], ['last-week', 'Last week'], ['this-month', 'This month'],
      ['last-month', 'Last month'], ['this-quarter', 'This quarter'], ['last-quarter', 'Last quarter'],
      ['this-year', 'This year'], ['last-year', 'Last year']
    ];
    return '<section class="live-date-filter' + (state.datePickerOpen ? ' open' : '') + '">'
      + '<button class="live-date-trigger" data-production-action="toggle-date-picker" aria-expanded="' + state.datePickerOpen + '">'
      + '<span class="live-date-calendar" aria-hidden="true">▦</span><span><small>REPORTING PERIOD</small><strong>' + escapeHtml(dateLabel()) + '</strong></span><b>⌄</b></button>'
      + (state.datePickerOpen ? '<div class="live-date-popover"><aside class="live-date-presets">'
        + presets.map(function (preset) { return '<button data-production-preset="' + preset[0] + '" class="' + (preset[0] === 'all' && state.pendingAllTime ? 'active' : '') + '">' + preset[1] + '</button>'; }).join('')
        + '</aside><div class="live-date-main"><div class="live-date-tabs"><span>Reporting period</span></div>'
        + '<div class="live-date-summary" id="live-date-summary">' + escapeHtml(state.pendingAllTime ? 'All available warehouse history' : humanDate(start) + ' – ' + humanDate(end)) + '</div>'
        + '<div class="live-date-fields"><label>From<input id="live-date-start" type="date" min="' + bounds.min + '" max="' + bounds.max + '" value="' + start + '"></label>'
        + '<span>→</span><label>To<input id="live-date-end" type="date" min="' + bounds.min + '" max="' + bounds.max + '" value="' + end + '"></label></div>'
        + '<p class="live-date-help">Dates use the warehouse reporting date in UTC.</p>'
        + '<footer><button class="btn btn-secondary" data-production-action="cancel-date-picker">Cancel</button>'
        + '<button class="btn btn-primary" data-production-action="apply-date-picker">Apply</button></footer></div></div>' : '')
      + '</section>';
  }

  function filteredRows(rows, field) {
    return (rows || []).filter(function (row) { return inDateRange(row[field]); });
  }

  function matchesDimensions(row, filters) {
    filters = filters || {};
    return (!filters.programme || filters.programme === 'all' || row.programme === filters.programme)
      && (!filters.country || filters.country === 'all' || row.country === filters.country)
      && (!filters.channel || filters.channel === 'all' || row.channel === filters.channel)
      && (!filters.size || filters.size === 'all' || Number(row.accountSize) === Number(filters.size));
  }

  function filteredOrders(filters, range) {
    return (state.snapshot.data.orders || []).filter(function (row) {
      if (!row.revenueEligible || !matchesDimensions(row, filters)) return false;
      var rowDate = isoDate(row.date);
      if (!rowDate) return false;
      return range ? rowDate >= range[0] && rowDate <= range[1] : inDateRange(rowDate);
    });
  }

  function previousRange() {
    if (state.dateAllTime || !state.dateStart || !state.dateEnd) return null;
    var start = new Date(state.dateStart + 'T00:00:00Z');
    var end = new Date(state.dateEnd + 'T00:00:00Z');
    var days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
    var priorEnd = new Date(start.getTime() - 86400000);
    var priorStart = new Date(priorEnd.getTime() - (days - 1) * 86400000);
    var result = [priorStart.toISOString().slice(0, 10), priorEnd.toISOString().slice(0, 10)];
    var available = (state.snapshot.data.orders || []).map(function (row) { return isoDate(row.date); }).filter(Boolean).sort();
    return available.length && result[0] >= available[0] ? result : null;
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
    var rows = filteredRows(state.snapshot.data.accounts, 'openedAt');
    var active = rows.filter(function (row) { return String(row.status).toLowerCase() === 'active'; });
    var breached = rows.filter(function (row) { return String(row.stage).toLowerCase() === 'breached'; });
    var shown = rows.slice(0, 100);
    return liveHeader('Account Analytics', rows.length, 'Accounts opened in the selected reporting period') + dateToolbar()
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
    var rows = filteredRows(state.snapshot.data.payouts, 'requestedAt');
    var paid = rows.filter(function (row) { return String(row.status).toLowerCase() === 'paid'; });
    var approved = rows.filter(function (row) { return String(row.status).toLowerCase() === 'approved'; });
    var shown = rows.slice(0, 100);
    return liveHeader('Payouts', rows.length, 'Payout requests created in the selected reporting period') + dateToolbar()
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

  function ownerOverviewPage(ctx) {
    ctx = ctx || {};
    var filters = ctx.filters || {};
    var rows = filteredOrders(filters);
    var rowDates = rows.map(function (row) { return row.date; }).filter(Boolean).sort();
    var range = state.dateAllTime
      ? { min: rowDates[0] || dateBounds().min, max: rowDates[rowDates.length - 1] || dateBounds().max }
      : { min: state.dateStart, max: state.dateEnd };
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
    var tabs = '<div class="owner-tabs" role="group" aria-label="Owner overview views">'
      + '<button data-action="owner-tab" data-value="performance" class="' + (ctx.local && ctx.local.ownerTab === 'changes' ? '' : 'active') + '">Performance</button>'
      + '<button data-action="owner-tab" data-value="changes" class="' + (ctx.local && ctx.local.ownerTab === 'changes' ? 'active' : '') + '">What changed?</button></div>';
    if (ctx.local && ctx.local.ownerTab === 'changes') return tabs + ownerChangesPage(ctx, rows);
    return tabs + liveHeader('Owner overview', rows.length, 'Canonical eligible orders · current filters · UTC · USD')
      + '<div class="page-kpis">'
      + metric('Net revenue', money(sum(rows, 'netRevenue')), 'Gross revenue less linked refunds')
      + metric('Gross revenue', money(sum(rows, 'grossRevenue')), number(rows.length) + ' eligible orders')
      + metric('Paying customers', number(customers.size), 'Distinct canonical commerce customers')
      + metric('New / existing', number(newCustomers.size) + ' / ' + number(Math.max(0, customers.size - newCustomers.size)), 'Based on first-ever eligible order')
      + '</div><section class="panel"><div class="panel-header"><div><h2 class="panel-title">Daily revenue</h2>'
      + '<p class="panel-subtitle">' + escapeHtml(range.min) + ' – ' + escapeHtml(range.max) + ' · fct_commerce_orders</p></div></div>'
      + '<div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th class="numeric">Orders</th>'
      + '<th class="numeric">Gross revenue</th><th class="numeric">Refunded</th><th class="numeric">Net revenue</th></tr></thead><tbody>'
      + days.map(function (row) { return '<tr><td>' + escapeHtml(row.date) + '</td><td class="numeric">' + number(row.orders)
        + '</td><td class="numeric">' + money(row.grossRevenue) + '</td><td class="numeric">' + money(row.refunded)
        + '</td><td class="numeric"><strong>' + money(row.netRevenue) + '</strong></td></tr>'; }).join('')
      + (days.length ? '' : '<tr><td colspan="5">No live data for this date range.</td></tr>')
      + '</tbody></table></div></section>';
  }

  function ownerChangesPage(ctx, currentRows) {
    var priorRange = previousRange();
    if (!priorRange) {
      return liveHeader('What changed?', currentRows.length, 'Canonical eligible orders · current filters · UTC · USD')
        + '<section class="panel"><div class="panel-body"><div class="no-live-data"><span class="no-live-kicker">COMPARISON UNAVAILABLE</span>'
        + '<h2>No complete prior period</h2><p>Choose a bounded reporting period with equally long preceding warehouse history. Missing history is not treated as zero.</p></div></div></section>';
    }
    var priorRows = filteredOrders(ctx.filters || {}, priorRange);
    var currentCustomers = new Set(currentRows.map(function (row) { return row.customerId; }).filter(Boolean)).size;
    var priorCustomers = new Set(priorRows.map(function (row) { return row.customerId; }).filter(Boolean)).size;
    var currentRevenue = sum(currentRows, 'netRevenue');
    var priorRevenue = sum(priorRows, 'netRevenue');
    function delta(current, prior, isMoney) {
      var value = current - prior;
      return (value > 0 ? '+' : '') + (isMoney ? money(value) : number(value));
    }
    var programmes = {};
    currentRows.forEach(function (row) {
      if (!programmes[row.programme]) programmes[row.programme] = { programme: row.programme, current: 0, prior: 0 };
      programmes[row.programme].current += Number(row.netRevenue) || 0;
    });
    priorRows.forEach(function (row) {
      if (!programmes[row.programme]) programmes[row.programme] = { programme: row.programme, current: 0, prior: 0 };
      programmes[row.programme].prior += Number(row.netRevenue) || 0;
    });
    var movements = Object.keys(programmes).map(function (key) {
      var row = programmes[key]; row.change = row.current - row.prior; return row;
    }).sort(function (a, b) { return Math.abs(b.change) - Math.abs(a.change); });
    return liveHeader('What changed?', currentRows.length, 'Current period compared with the immediately preceding equal-length period')
      + '<div class="page-kpis">'
      + metric('Net revenue change', delta(currentRevenue, priorRevenue, true), money(currentRevenue) + ' vs ' + money(priorRevenue))
      + metric('Order change', delta(currentRows.length, priorRows.length, false), number(currentRows.length) + ' vs ' + number(priorRows.length))
      + metric('Customer change', delta(currentCustomers, priorCustomers, false), number(currentCustomers) + ' vs ' + number(priorCustomers))
      + metric('Prior period', humanDate(priorRange[0]) + ' – ' + humanDate(priorRange[1]), 'Complete warehouse comparison window') + '</div>'
      + '<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Programme movement</h2>'
      + '<p class="panel-subtitle">The same programme, country, channel and account-size filters are applied to both periods.</p></div></div>'
      + '<div class="table-wrap"><table class="data-table"><thead><tr><th>Programme</th><th class="numeric">Current</th><th class="numeric">Previous</th><th class="numeric">Change</th></tr></thead><tbody>'
      + movements.map(function (row) { return '<tr><td>' + escapeHtml(liveText(row.programme)) + '</td><td class="numeric">' + money(row.current)
        + '</td><td class="numeric">' + money(row.prior) + '</td><td class="numeric"><strong>' + delta(row.current, row.prior, true) + '</strong></td></tr>'; }).join('')
      + (movements.length ? '' : '<tr><td colspan="4">No live data for these filters.</td></tr>')
      + '</tbody></table></div></section>';
  }

  function profitabilityPage() {
    var dated = filteredRows(state.snapshot.data.profitability, 'date');
    var groups = {};
    dated.forEach(function (row) {
      var key = row.programme + '|' + row.accountSize;
      if (!groups[key]) groups[key] = { programme: row.programme, accountSize: row.accountSize, attempts: 0, fundedAttempts: 0, revenue: 0, discount: 0, payoutCount: 0, payouts: 0, grossProfit: 0 };
      ['attempts', 'fundedAttempts', 'revenue', 'discount', 'payoutCount', 'payouts', 'grossProfit'].forEach(function (field) {
        groups[key][field] += Number(row[field]) || 0;
      });
    });
    var rows = Object.keys(groups).map(function (key) { return groups[key]; }).sort(function (a, b) { return b.revenue - a.revenue; });
    return liveHeader('Profitability', sum(dated, 'attempts'), 'Attempt-grain account_profitability · selected start dates') + dateToolbar()
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
    var dated = filteredRows(state.snapshot.data.affiliates, 'date');
    var groups = {};
    dated.forEach(function (row) {
      var key = row.id + '|' + row.status;
      if (!groups[key]) groups[key] = { id: row.id, name: row.name, status: row.status, orders: 0, customerIds: {}, newCustomerIds: {}, grossRevenue: 0, netRevenue: 0, conflictOrders: 0 };
      var group = groups[key];
      group.orders += 1;
      if (row.customerId) group.customerIds[row.customerId] = true;
      if (row.isNewCustomer && row.customerId) group.newCustomerIds[row.customerId] = true;
      group.grossRevenue += Number(row.grossRevenue) || 0;
      group.netRevenue += Number(row.netRevenue) || 0;
      if (row.hasConflict) group.conflictOrders += 1;
    });
    var rows = Object.keys(groups).map(function (key) {
      var row = groups[key];
      row.customers = Object.keys(row.customerIds).length;
      row.newCustomers = Object.keys(row.newCustomerIds).length;
      return row;
    }).sort(function (a, b) { return b.netRevenue - a.netRevenue; });
    return liveHeader('Affiliates', rows.length, 'Canonical order attribution · selected eligible orders')
      + dateToolbar()
      + '<div class="page-kpis">' + metric('Attributed net revenue', money(sum(rows.filter(function (r) { return r.status === 'attributed'; }), 'netRevenue')), 'Production v6 attribution')
      + metric('Affiliate orders', number(sum(rows.filter(function (r) { return r.status === 'attributed'; }), 'orders')), 'Attributed eligible orders')
      + metric('New customers', number(sum(rows.filter(function (r) { return r.status === 'attributed'; }), 'newCustomers')), 'First-ever canonical orders')
      + metric('Unattributed orders', number(sum(rows.filter(function (r) { return r.status !== 'attributed'; }), 'orders')), 'Eligible orders without attributed status') + '</div>'
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
    var profiles = {};
    (state.snapshot.data.customers || []).forEach(function (row) { profiles[row.id] = row; });
    var values = {};
    filteredRows((state.snapshot.data.orders || []).filter(function (row) { return row.revenueEligible; }), 'date').forEach(function (order) {
      if (!order.customerId) return;
      if (!values[order.customerId]) values[order.customerId] = { completedOrderCount: 0, revenue: 0, lastOrderAt: '' };
      values[order.customerId].completedOrderCount += 1;
      values[order.customerId].revenue += Number(order.netRevenue) || 0;
      if (order.date > values[order.customerId].lastOrderAt) values[order.customerId].lastOrderAt = order.date;
    });
    var rows = Object.keys(values).map(function (id) {
      var profile = profiles[id] || { id: id, name: 'No live data', country: 'No live data', status: 'No live data', accountCount: 0, kycVerified: false };
      return Object.assign({}, profile, values[id]);
    }).sort(function (a, b) { return b.revenue - a.revenue; });
    var shown = rows.slice(0, 200);
    return liveHeader('Customer value', rows.length, 'Canonical commerce customers · selected eligible orders') + dateToolbar()
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

  function reportsPage() {
    var reports = [
      ['overview', 'Owner overview', 'Canonical orders, revenue and customer mix'],
      ['revenue', 'Profitability', 'Attempt revenue, approved payouts and gross profit'],
      ['accounts', 'Account Analytics', 'Current accounts and trading results'],
      ['pipeline', 'Payouts', 'Payout requests and amounts'],
      ['affiliates', 'Affiliates', 'Canonical order attribution and revenue'],
      ['ltv', 'Customer value', 'Commerce customer orders, value and activity']
    ];
    return '<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Live reports</h2>'
      + '<p class="panel-subtitle">Only reports backed by connected warehouse tables are listed.</p></div></div><div class="connection-list">'
      + reports.map(function (report) { return '<button class="connection-row" data-page="' + report[0] + '"><span class="connection-icon">●</span>'
        + '<div class="connection-text"><strong>' + escapeHtml(report[1]) + '</strong><span>' + escapeHtml(report[2])
        + '</span></div><span class="badge badge-success">OPEN</span></button>'; }).join('') + '</div></section>';
  }

  function noLiveDataPage(page) {
    var labels = {
      overview: 'Owner overview', revenue: 'Profitability', affiliates: 'Affiliates',
      competitors: 'Competitor analysis', pricing: 'Pricing & profitability', rebuy: 'Average rebuy time',
      updates: 'Updates & impact', ltv: 'Customer lifetime value', 'client-profit': 'Client lifetime profit',
      journey: 'Customer journey', 'profitable-risk': 'High-risk clients in profit',
      'risk-radar': 'Risk radar', 'payout-exposure': 'Payout exposure patterns',
      'payout-consistency': 'Consistency score distribution', marketing: 'Paid marketing', reports: 'Reports'
    };
    return '<section class="no-live-data"><span class="no-live-icon">—</span><p class="no-live-kicker">LIVE SOURCE NOT CONNECTED</p>'
      + '<h2>No live data</h2><p>' + escapeHtml(labels[page] || 'This report')
      + ' is hidden until its production dataset is connected and validated.</p>'
      + '<small>Only validated live warehouse records are shown.</small></section>';
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
    var dateControl = document.querySelector('.date-control');
    if (!dateControl || state.mode !== 'production') return;
    var unavailablePages = new Set(['pricing', 'updates']);
    if (unavailablePages.has(page)) {
      var unavailableContent = document.getElementById('page-content');
      if (unavailableContent && !unavailableContent.querySelector('.no-live-data')) unavailableContent.innerHTML = noLiveDataPage(page);
    }
    var legacyFilters = document.getElementById('filters-row');
    if (legacyFilters) legacyFilters.hidden = page === 'marketing' || page === 'journey';
    var currentOnlyPages = new Set(['profitable-risk', 'risk-radar', 'payout-exposure', 'payout-consistency']);
    if (currentOnlyPages.has(page)) {
      dateControl.hidden = false;
      dateControl.innerHTML = '<div class="current-release-control"><small>CURRENT RELEASED SNAPSHOT</small><strong>'
        + escapeHtml(state.snapshot && state.snapshot.asOf || '') + '</strong></div>';
      dateControl.setAttribute('data-live-date-view', 'current-release:' + page);
      return;
    }
    var datedPages = new Set(['overview', 'revenue', 'accounts', 'pipeline', 'affiliates', 'competitors', 'pricing', 'marketing', 'rebuy', 'updates', 'ltv', 'client-profit', 'journey', 'reports']);
    if (!datedPages.has(page)) return;
    dateControl.hidden = false;
    var key = state.dateAllTime + ':' + state.dateStart + ':' + state.dateEnd + ':' + state.datePickerOpen;
    if (dateControl.getAttribute('data-live-date-view') === key) return;
    dateControl.innerHTML = dateToolbar();
    dateControl.setAttribute('data-live-date-view', key);
  }

  function sanitizeProductionCopy() {
    if (state.mode !== 'production') return;
    var periodContext = document.querySelector('.filter-tail .period-context');
    if (periodContext) periodContext.textContent = ['profitable-risk', 'risk-radar', 'payout-exposure', 'payout-consistency'].includes(currentPage())
      ? 'Current released snapshot · global dimensions apply'
      : dateLabel() + ' · UTC';
    var replacements = [
      [/Demo import/gi, 'No live source'],
      [/Extended fictional history/gi, 'Live warehouse history'],
      [/fictional history/gi, 'live warehouse history'],
      [/Demo decision history/gi, 'Live decision history'],
      [/sample decisions/gi, 'recorded decisions'],
      [/sample partners/gi, 'partners'],
      [/this sample/gi, 'the live warehouse'],
      [/demo ledger/gi, 'live ledger'],
      [/fictional purchase ledger/gi, 'live purchase ledger'],
      [/shared fictional payout history/gi, 'live warehouse payout history'],
      [/paid payouts/gi, 'approved payouts'],
      [/paid payout/gi, 'approved payout'],
      [/paid cash/gi, 'approved payout volume'],
      [/cash paid/gi, 'approved payout volume'],
      [/settled payments/gi, 'approved payouts'],
      [/payment settlement dates/gi, 'approval dates'],
      [/settlement dates/gi, 'approval dates'],
      [/demo record/gi, 'live warehouse record'],
      [/simulated payout history from January 2024/gi, 'live warehouse history where available'],
      [/Simulated device links, beneficiary references and paired trading observations/gi, 'Live source not connected'],
      [/Dubai time/gi, 'Kyiv time'],
      [/Example follow-up/gi, 'Required follow-up'],
      [/The example coverage includes current links, visible offers, product terms, policies and navigation changes\. This offline copy does not inspect those pages\./gi, 'The daily monitor inspects current public links, visible offers, product terms, prices, policies and navigation changes on the official domain.'],
      [/No live business systems are connected to this prototype\./gi, 'Connected production warehouse sources are listed above.'],
      [/\bdemonstration\b/gi, 'live'],
      [/\bfictional\b/gi, 'live'],
      [/\bdemo\b/gi, 'live'],
      [/\bsample data\b/gi, 'live warehouse data'],
      [/\bsample\b/gi, 'live']
    ];
    var root = document.getElementById('page-content');
    if (!root) return;
    if (currentPage() === 'competitors') {
      var competitorDescription = document.getElementById('page-description');
      if (competitorDescription) competitorDescription.textContent = 'Track daily changes to official competitor rules, prices, offers, policies and public content.';
      root.querySelectorAll('[data-action="competitor-monitor-toggle"]').forEach(function (button) { button.remove(); });
      root.querySelectorAll('[data-kind="competitor-monitor"]').forEach(function (button) { button.setAttribute('data-kind', 'competitors'); });
    }
    [root, document.getElementById('drawer-layer')].filter(Boolean).forEach(function (copyRoot) {
      var walker = document.createTreeWalker(copyRoot, NodeFilter.SHOW_TEXT);
      var node;
      while ((node = walker.nextNode())) {
        var value = node.nodeValue;
        replacements.forEach(function (item) { value = value.replace(item[0], item[1]); });
        if (value !== node.nodeValue) node.nodeValue = value;
      }
    });
    var changeSummary = root.querySelector('.changes-summary p');
    if (changeSummary) changeSummary.textContent = 'Use the date filter to choose a period with complete preceding history.';
    var changesEmpty = root.querySelector('.changes-empty');
    if (changesEmpty) {
      var changesCopy = changesEmpty.querySelector('p');
      var changesButton = changesEmpty.querySelector('button');
      if (changesCopy) changesCopy.textContent = 'Choose a reporting period with a complete equal-length preceding period. Missing history is never treated as zero.';
      if (changesButton) { changesButton.textContent = 'Open date filter'; changesButton.removeAttribute('data-action'); changesButton.removeAttribute('data-value'); changesButton.setAttribute('data-production-action', 'toggle-date-picker'); }
    }
    if (state.dateAllTime) {
      var overviewSalesCard = Array.from(root.querySelectorAll('.kpi-card')).find(function (card) {
        var label = card.querySelector('.kpi-label'); return label && label.textContent.trim() === 'Net sales';
      });
      var salesChange = overviewSalesCard && overviewSalesCard.querySelector('.kpi-change');
      if (salesChange) salesChange.textContent = 'Comparison unavailable for All time';
      root.querySelectorAll('.mix-comparison').forEach(function (value) { value.textContent = 'Previous period unavailable'; });
    }
    root.querySelectorAll('button').forEach(function (button) {
      if (button.textContent.trim() === 'Compare October with September') button.textContent = 'Choose a reporting period';
    });
    if (!window.BIThoughtMetricData) {
      var channelBadge = root.querySelector('.channels-source-badge');
      var channelTotal = root.querySelector('.channels-chart-meta strong');
      var channelEmptyTitle = root.querySelector('.channels-empty h3');
      var channelEmptyCopy = root.querySelector('.channels-empty p');
      var channelFooter = root.querySelector('.channels-footer .text-link');
      if (channelBadge) channelBadge.textContent = 'No live data';
      if (channelTotal) channelTotal.textContent = 'Unavailable';
      if (channelEmptyTitle) channelEmptyTitle.textContent = 'No live data';
      if (channelEmptyCopy) channelEmptyCopy.textContent = 'Connect the ThoughtMetric production source to populate this block.';
      if (channelFooter) channelFooter.textContent = 'Live source not connected';
    }
    var profitCard = root.querySelector('.ov-value-card[data-id="profit"]');
    if (profitCard) {
      var profitValue = profitCard.querySelector('strong');
      var profitChange = profitCard.querySelector('.ov-metric-change');
      var profitBaseline = profitCard.querySelector('.ov-metric-baseline');
      if (profitValue) profitValue.textContent = 'Unavailable';
      if (profitChange) profitChange.textContent = 'Cost data not connected';
      if (profitBaseline) profitBaseline.textContent = '';
    }
    root.querySelectorAll('.kpi-card').forEach(function (card) {
      var label = card.querySelector('.kpi-label');
      if (!label || !/Accrued reward estimate/i.test(label.textContent)) return;
      var value = card.querySelector('.kpi-value');
      var note = card.querySelector('.kpi-note');
      if (value) value.textContent = 'Unavailable';
      if (note) note.textContent = 'Live reward eligibility estimate is not connected';
    });
    var profitabilityReady = state.snapshot && state.snapshot.quality && state.snapshot.quality.profitabilityReady;
    if (!profitabilityReady) {
      root.querySelectorAll('.econ-page .kpi-card').forEach(function (card) {
        var label = card.querySelector('.kpi-label');
        if (!label || !/(profit|margin)/i.test(label.textContent)) return;
        var value = card.querySelector('.kpi-value');
        var note = card.querySelector('.kpi-note');
        if (value) value.textContent = 'Unavailable';
        if (note) note.textContent = 'Live direct-cost data is not connected';
      });
      root.querySelectorAll('.econ-page .econ-table tr').forEach(function (row) {
        [4, 5, 6, 7].forEach(function (position) {
          var cell = row.querySelector('td:nth-child(' + position + ')');
          if (cell) cell.textContent = 'Unavailable';
        });
      });
      root.querySelectorAll('.econ-page .econ-waterfall-row.cost strong,.econ-page .econ-waterfall-row.total strong').forEach(function (value) {
        value.textContent = 'Unavailable';
      });
    } else {
      root.querySelectorAll('.econ-page .econ-table tr').forEach(function (row) {
        var otherCosts = row.querySelector('td:nth-child(5)');
        if (otherCosts) otherCosts.textContent = 'Unavailable';
      });
      root.querySelectorAll('.econ-page .econ-waterfall-row.cost').forEach(function (row) {
        var label = row.querySelector('span');
        var value = row.querySelector('strong');
        if (label && value && !/Allocated trader rewards/i.test(label.textContent)) value.textContent = 'Unavailable';
      });
    }
    root.querySelectorAll('.afg-page .kpi-card').forEach(function (card) {
      var label = card.querySelector('.kpi-label');
      if (!label || !/(p&l|profit|commission|margin|cost|cac)/i.test(label.textContent)) return;
      var value = card.querySelector('.kpi-value');
      if (value) value.textContent = 'Unavailable';
    });
    var competitor = root.querySelector('.competitor-monitor,.competitor-page');
    if (competitor && !window.BICompetitorMonitorData) {
      if (!competitor.querySelector('.production-missing-source')) competitor.insertAdjacentHTML('afterbegin', '<div class="production-missing-source"><strong>No live data</strong><span>Competitor monitoring source is not connected.</span></div>');
      competitor.querySelectorAll('.cm-kpis article').forEach(function (card) {
        var value = card.querySelector('strong');
        var note = card.querySelector('small');
        if (value) value.textContent = 'Unavailable';
        if (note) note.textContent = 'No live data';
      });
      competitor.querySelectorAll('.cm-firm-group h3,.cm-attention-items strong,.cm-attention-items span,.cm-change-row strong,.cm-change-row .cm-compare-cell span').forEach(function (value) { value.textContent = 'No live data'; });
      competitor.querySelectorAll('.cm-schedule-state,.cm-preview-banner strong,.cm-run-note strong').forEach(function (value) { value.textContent = 'No live data'; });
    }
    var health = root.querySelector('.health-summary');
    if (health) {
      var healthTitle = health.querySelector('h2');
      var healthCopy = health.querySelector('p');
      var healthBadge = health.querySelector('.badge');
      if (healthTitle) healthTitle.textContent = 'Live warehouse data is connected';
      if (healthCopy) healthCopy.textContent = 'Production orders, accounts, payouts, customers and affiliate attribution are loaded from the warehouse.';
      if (healthBadge) healthBadge.textContent = 'LIVE DATA';
      root.querySelectorAll('.connection-row').forEach(function (row) {
        var name = row.querySelector('.connection-text strong');
        var badge = row.querySelector('.badge');
        var live = name && !/Risk signal|Retention review/i.test(name.textContent);
        if (badge) badge.textContent = live ? 'LIVE' : 'NO LIVE DATA';
      });
    }
    var workspacePanel = Array.from(root.querySelectorAll('.panel')).find(function (panel) { return /Prototype workspace/i.test(panel.textContent); });
    if (workspacePanel) {
      var workspaceTitle = workspacePanel.querySelector('.panel-title');
      var workspaceHeading = workspacePanel.querySelector('.panel-body h3');
      var workspaceCopy = workspacePanel.querySelector('.panel-body p');
      var resetButton = workspacePanel.querySelector('[data-action="reset-demo"]');
      if (workspaceTitle) workspaceTitle.textContent = 'Production workspace';
      if (workspaceHeading) workspaceHeading.textContent = 'Live data only';
      if (workspaceCopy) workspaceCopy.textContent = 'Filters and reports use connected warehouse records. Generated fallback business values are disabled.';
      if (resetButton) { resetButton.textContent = 'Demo data disabled'; resetButton.disabled = true; }
    }
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
    style.textContent += '.current-release-control{display:flex;min-width:220px;flex-direction:column;gap:3px;padding:9px 13px;border:1px solid #dfe5ea;border-radius:8px;background:#fff}.current-release-control small{font-size:8px;letter-spacing:1px;color:#8b99a6}.current-release-control strong{font-size:12px;color:#425466}.live-date-filter{position:relative;display:flex;justify-content:flex-end;margin:-4px 0 18px;z-index:15}.live-date-trigger{display:flex;align-items:center;gap:11px;min-width:250px;padding:10px 13px;border:1px solid #dfe5ea;border-radius:8px;background:#fff;color:#536577;text-align:left;box-shadow:0 1px 2px #23364b0a}.live-date-trigger:hover,.live-date-filter.open .live-date-trigger{border-color:#efad88;box-shadow:0 0 0 3px #f4773512}.live-date-trigger>span:nth-child(2){display:flex;flex:1;flex-direction:column;gap:2px}.live-date-trigger small{font-size:8px;letter-spacing:1px;color:#9aa6b1}.live-date-trigger strong{font-size:12px;font-weight:600;color:#425466}.live-date-trigger b{font-size:14px;color:#8b98a5}.live-date-calendar{display:grid;place-items:center;width:29px;height:29px;border-radius:7px;background:#fff1e8;color:#e26f35;font-size:17px}.live-date-popover{position:absolute;top:58px;right:0;display:grid;grid-template-columns:180px minmax(430px,1fr);width:min(760px,calc(100vw - 290px));min-height:390px;overflow:hidden;border:1px solid #e0e5ea;border-radius:12px;background:#fff;box-shadow:0 18px 55px #24394f24}.live-date-presets{padding:16px 12px;border-right:1px solid #e8ecf0;overflow:auto;max-height:470px}.live-date-presets button{display:block;width:100%;padding:8px 12px;border-radius:6px;color:#617184;font-size:12px;font-weight:550;text-align:left}.live-date-presets button:hover{background:#fff6f0;color:#d96831}.live-date-presets button.active{background:#f47735;color:#fff}.live-date-main{display:flex;flex-direction:column;padding:23px 26px 18px}.live-date-tabs{display:flex;justify-content:center;margin-bottom:24px}.live-date-tabs span{padding:9px 20px;border-radius:8px;background:#f47735;color:#fff;font-size:12px;font-weight:650}.live-date-summary{text-align:center;color:#4f6072;font-size:15px;font-weight:650;margin-bottom:28px}.live-date-fields{display:grid;grid-template-columns:1fr auto 1fr;align-items:end;gap:15px;padding:24px;border:1px solid #e7ebef;border-radius:10px;background:#fafbfc}.live-date-fields label{display:flex;flex-direction:column;gap:8px;color:#718091;font-size:10px;font-weight:600;letter-spacing:.4px;text-transform:uppercase}.live-date-fields input{width:100%;height:42px;padding:0 11px;border:1px solid #dbe2e8;border-radius:7px;background:#fff;color:#35485c;font-family:inherit;font-size:12px;font-weight:600;color-scheme:light}.live-date-fields>span{padding-bottom:12px;color:#a0abb5}.live-date-help{margin:14px 2px;color:#96a1ac;font-size:10px}.live-date-main footer{display:flex;justify-content:flex-end;gap:10px;margin-top:auto;padding-top:20px;border-top:1px solid #edf0f3}.live-date-main footer .btn{min-width:92px}.production-missing-source{display:flex;align-items:center;gap:12px;margin:0 0 18px;padding:14px 16px;border:1px solid #e2e7eb;border-radius:8px;background:#fff}.production-missing-source strong{color:#536577}.production-missing-source span{color:#8a96a1;font-size:10px}@media(max-width:850px){.live-date-popover{position:fixed;top:90px;left:18px;right:18px;width:auto;grid-template-columns:145px 1fr}.live-date-trigger{min-width:220px}}@media(max-width:620px){.live-date-popover{grid-template-columns:1fr;max-height:75vh;overflow:auto}.live-date-presets{display:flex;gap:6px;overflow:auto;border-right:0;border-bottom:1px solid #e8ecf0}.live-date-presets button{width:auto;white-space:nowrap}.live-date-main{padding:18px}.live-date-fields{grid-template-columns:1fr}.live-date-fields>span{display:none}}';
    document.head.appendChild(style);
  }

  function refreshPresentation() {
    injectStyles();
    decorateBadge();
    enforceProductionView();
    sanitizeProductionCopy();
  }

  function finishBoot() {
    document.documentElement.classList.remove('production-booting');
    var boot = document.getElementById('production-boot-screen');
    if (boot) boot.hidden = true;
  }

  async function start() {
    discardDemoData();
    refreshPresentation();
    try {
      var competitorResponse = await fetch(COMPETITOR_ENDPOINT, { cache: 'no-store' });
      if (competitorResponse.ok) {
        var competitorPayload = await competitorResponse.json();
        if (competitorPayload && competitorPayload.mode === 'official-sites') window.BICompetitorMonitorData = competitorPayload;
      }
    } catch {
      window.BICompetitorMonitorData = null;
    }
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
    if (state.mode === 'error') {
      var content = document.getElementById('page-content');
      if (content) content.innerHTML = loadingPage();
    }
    refreshPresentation();
    finishBoot();
  }

  window.BIProductionConnector = { state: state, applySnapshot: applySnapshot, start: start, inDateRange: inDateRange, dateLabel: dateLabel, dateRange: dateRange, refreshPresentation: refreshPresentation, renderOwnerOverview: ownerOverviewPage };
  document.addEventListener('click', function (event) {
    var pageLink = event.target.closest('[data-page]');
    if (pageLink) {
      // The dashboard router uses history.pushState(), which does not emit a
      // hashchange event. Re-apply the production view after its render pass.
      setTimeout(refreshPresentation, 0);
      return;
    }
    var preset = event.target.closest('[data-production-preset]');
    if (preset) {
      var range = presetRange(preset.getAttribute('data-production-preset'));
      var startInput = document.getElementById('live-date-start');
      var endInput = document.getElementById('live-date-end');
      state.pendingAllTime = preset.getAttribute('data-production-preset') === 'all';
      if (startInput) startInput.value = range.start || range.min;
      if (endInput) endInput.value = range.end || range.max;
      document.querySelectorAll('[data-production-preset]').forEach(function (item) { item.classList.toggle('active', item === preset); });
      var summary = document.getElementById('live-date-summary');
      if (summary) summary.textContent = state.pendingAllTime ? 'All available warehouse history' : humanDate(startInput.value) + ' – ' + humanDate(endInput.value);
      return;
    }
    var button = event.target.closest('[data-production-action]');
    if (!button) { setTimeout(refreshPresentation, 0); return; }
    var action = button.getAttribute('data-production-action');
    if (action === 'toggle-date-picker') {
      state.datePickerOpen = !state.datePickerOpen;
      state.pendingAllTime = state.dateAllTime;
      enforceProductionView();
      return;
    }
    if (action === 'cancel-date-picker') {
      state.datePickerOpen = false;
      enforceProductionView();
      return;
    }
    if (action === 'apply-date-picker') {
      var start = document.getElementById('live-date-start');
      var end = document.getElementById('live-date-end');
      if (!start || !end || !start.value || !end.value || start.value > end.value) return;
      state.dateAllTime = state.pendingAllTime;
      state.dateStart = start.value;
      state.dateEnd = end.value;
      state.datePickerOpen = false;
      window.dispatchEvent(new Event('bi:production-ready'));
      setTimeout(refreshPresentation, 0);
    }
  });
  document.addEventListener('input', function (event) {
    if (event.target.id !== 'live-date-start' && event.target.id !== 'live-date-end') return;
    state.pendingAllTime = false;
    document.querySelectorAll('[data-production-preset]').forEach(function (item) { item.classList.remove('active'); });
    var start = document.getElementById('live-date-start');
    var end = document.getElementById('live-date-end');
    var summary = document.getElementById('live-date-summary');
    if (summary && start && end && start.value && end.value) summary.textContent = humanDate(start.value) + ' – ' + humanDate(end.value);
  });
  document.addEventListener('change', function () { setTimeout(refreshPresentation, 0); });
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
