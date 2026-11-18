(function () {
  'use strict';

  self.onmessage = async function (event) {
    try {
      var url = event.data && event.data.url;
      if (!url) throw new Error('Snapshot URL is missing.');
      var response = await fetch(url, { cache: 'default', credentials: 'same-origin' });
      if (!response.ok) throw new Error('Live snapshot request failed with HTTP ' + response.status + '.');
      var text = await response.text();
      var payload = JSON.parse(text);
      self.postMessage({ ok: true, payload: payload, revision: response.headers.get('etag') || '' });
    } catch (error) {
      self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
})();
