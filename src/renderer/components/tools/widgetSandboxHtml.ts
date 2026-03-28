/**
 * Sandbox iframe receiver HTML for Generative UI widgets.
 *
 * This HTML is injected as the iframe's `srcdoc`. It:
 * - Sets a strict CSP (only 4 CDN domains for scripts, no connect-src)
 * - Listens for postMessage commands: widget:update (streaming), widget:finalize (final)
 * - Reports height changes back to the parent via widget:resize
 * - Intercepts link clicks and forwards them to the parent via widget:link
 */

export function buildSandboxHtml(cssVarsBlock: string): string {
  // The receiver template. All dynamic content arrives via postMessage.
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://esm.sh; img-src data: https:; font-src https://cdn.jsdelivr.net https://cdnjs.cloudflare.com;">
<style>
${cssVarsBlock}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
body { font-family: system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; font-size: 16px; line-height: 1.6; color: var(--widget-text); }
#root { min-height: 20px; }
</style>
</head>
<body>
<div id="root"></div>
<script>
(function() {
  var root = document.getElementById('root');
  var currentHtml = '';
  var finalized = false;

  // Height reporting via ResizeObserver
  var lastHeight = 0;
  var firstResize = true;
  function reportHeight() {
    var h = document.body.scrollHeight;
    if (h !== lastHeight) {
      lastHeight = h;
      window.parent.postMessage({ type: 'widget:resize', height: h, first: firstResize }, '*');
      firstResize = false;
    }
  }
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(reportHeight).observe(root);
  }
  // Also report on load and after script execution
  window.addEventListener('load', reportHeight);

  // Link interception — open in parent's system browser
  document.addEventListener('click', function(e) {
    var a = e.target;
    while (a && a.tagName !== 'A') a = a.parentElement;
    if (a && a.href) {
      e.preventDefault();
      window.parent.postMessage({ type: 'widget:link', href: a.href }, '*');
    }
  });

  // Execute script tags (innerHTML doesn't run them)
  function runScripts() {
    var scripts = root.querySelectorAll('script');
    scripts.forEach(function(old) {
      var s = document.createElement('script');
      if (old.src) { s.src = old.src; }
      else { s.textContent = old.textContent; }
      // Copy attributes (type, etc.)
      Array.from(old.attributes).forEach(function(attr) {
        if (attr.name !== 'src') s.setAttribute(attr.name, attr.value);
      });
      old.parentNode.replaceChild(s, old);
    });
    // Report height after scripts run
    requestAnimationFrame(reportHeight);
  }

  // Message handler
  window.addEventListener('message', function(e) {
    if (!e.data || !e.data.type) return;

    if (e.data.type === 'widget:update' && !finalized) {
      // Streaming preview — update HTML without executing scripts
      if (e.data.html !== currentHtml) {
        currentHtml = e.data.html;
        root.innerHTML = currentHtml;
        reportHeight();
      }
    }

    if (e.data.type === 'widget:finalize') {
      finalized = true;
      var newHtml = e.data.html;
      if (newHtml !== currentHtml) {
        root.innerHTML = newHtml;
        currentHtml = newHtml;
      }
      runScripts();
      reportHeight();
    }

    if (e.data.type === 'widget:theme') {
      // Theme update — inject new CSS variables
      var styleEl = document.getElementById('theme-vars');
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'theme-vars';
        document.head.appendChild(styleEl);
      }
      styleEl.textContent = e.data.css;
      reportHeight();
    }
  });

  // Signal ready
  window.parent.postMessage({ type: 'widget:ready' }, '*');
})();
</script>
</body>
</html>`;
}
