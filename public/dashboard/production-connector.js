(function () {
  'use strict';

  var STATUS_ENDPOINT = 'data/connection-manifest.json';
  var SNAPSHOT_ENDPOINT = '/api/bi/snapshot';
  var state = { mode: 'demo', manifest: null, snapshot: null, error: null };

  function replaceArray(target, source) {
    if (!Array.isArray(target) || !Array.isArray(source)) return false;
    target.splice.apply(target, [0, target.length].concat(source));
    return true;
  }

  function validSnapshot(payload) {
    return payload && payload.schemaVersion === 1 && payload.mode === 'production'
      && payload.data && typeof payload.data === 'object'
      && /^\d{4}-\d{2}-\d{2}$/.test(String(payload.asOf || ''));
  }

  function applySnapshot(payload) {
    if (!validSnapshot(payload) || !window.BIData) return false;
    var data = payload.data;
    var applied = 0;
    ['accounts', 'payouts', 'affiliates', 'customers', 'riskCases'].forEach(function (key) {
      if (Array.isArray(data[key]) && replaceArray(window.BIData[key], data[key])) applied += 1;
    });
    if (payload.quality && payload.quality.profitabilityReady === true
        && Array.isArray(data.orders) && replaceArray(window.BIData.orders, data.orders)) {
      applied += 1;
    }
    if (!applied) return false;
    window.BIData.asOf = payload.asOf;
    window.BIData.currency = payload.currency || 'USD';
    window.BIData.demo = false;
    window.BIData.productionQuality = payload.quality || {};
    state.mode = 'production';
    state.snapshot = payload;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return true;
  }

  function decorateBadge() {
    var badge = document.querySelector('.demo-badge');
    if (!badge) return;
    if (state.mode === 'production') {
      var partial = state.snapshot && state.snapshot.quality && state.snapshot.quality.partial === true;
      badge.textContent = partial ? 'LIVE · PARTIAL' : 'LIVE DATA';
      badge.title = partial
        ? 'Live production data is enabled for selected screens. Open Data health for coverage details.'
        : 'Production snapshot loaded through the read-only BI API.';
    } else if (state.manifest) {
      badge.textContent = 'DEMO FALLBACK';
      badge.title = 'Production sources are mapped. Read-only credentials or a Warehouse API are still required.';
    }
  }

  function injectHealthStatus() {
    if (location.hash !== '#health' || !state.manifest) return;
    var content = document.getElementById('page-content');
    if (!content || content.querySelector('[data-production-status]')) return;
    var screens = Object.keys(state.manifest.screens || {}).map(function (key) {
      var item = state.manifest.screens[key];
      return '<div class="connection-row"><span class="connection-icon">●</span><div class="connection-text"><strong>'
        + item.label + '</strong><span>' + item.sources.join(' · ') + '</span></div><span class="badge badge-neutral">'
        + item.state.replace(/_/g, ' ') + '</span></div>';
    }).join('');
    var panel = document.createElement('section');
    panel.className = 'panel';
    panel.setAttribute('data-production-status', '');
    panel.style.marginBottom = '20px';
    panel.innerHTML = '<div class="panel-header"><div><h2 class="panel-title">Production connection</h2><p class="panel-subtitle">BigQuery mapping is installed; demo remains active until the read-only API is available.</p></div><span class="badge badge-warning">Awaiting access</span></div><div class="connection-list">' + screens + '</div>';
    content.insertBefore(panel, content.firstChild);
  }

  function refreshPresentation() {
    decorateBadge();
    injectHealthStatus();
  }

  async function start() {
    try {
      var manifestResponse = await fetch(STATUS_ENDPOINT, { cache: 'no-store' });
      if (manifestResponse.ok) state.manifest = await manifestResponse.json();
    } catch (error) {
      state.error = error;
    }
    try {
      var response = await fetch(SNAPSHOT_ENDPOINT, { cache: 'no-store', credentials: 'same-origin' });
      if (response.ok) applySnapshot(await response.json());
    } catch (error) {
      state.error = error;
    }
    refreshPresentation();
  }

  window.BIProductionConnector = { state: state, applySnapshot: applySnapshot, start: start };
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

