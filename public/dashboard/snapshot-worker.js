(function () {
  'use strict';

  self.onmessage = async function (event) {
    try {
      var url = event.data && event.data.url;
      if (!url) throw new Error('Snapshot URL is missing.');
      var response = await fetch(url, { cache: 'default', credentials: 'same-origin' });
      if (!response.ok) throw new Error('Live snapshot request failed with HTTP ' + response.status + '.');
      // Transfer the compressed/decompressed response bytes to the main thread
      // without parsing and structured-cloning the complete warehouse object in
      // the worker. The previous text -> object -> postMessage path temporarily
      // kept the response text and two full object graphs in memory.
      var buffer = await response.arrayBuffer();
      self.postMessage({ ok: true, buffer: buffer, revision: response.headers.get('etag') || '' }, [buffer]);
    } catch (error) {
      self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
})();
