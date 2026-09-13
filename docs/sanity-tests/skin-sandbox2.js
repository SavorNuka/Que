// Verifies the load-bearing security claim in ARCHITECTURE §14.
// Served over real HTTP from one origin, matching the actual design
// (sanitized skin written to a file, loaded into an <iframe> by src).
const http = require('http');
const { chromium } = require('playwright');

const SKIN = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="out" data-que-bind="title">unbound</div>
<button data-que-action="play">Play</button>
<script>document.getElementById("out").textContent = "INLINE SCRIPT RAN";</script>
<img src="does-not-exist.png" onerror="document.getElementById('out').textContent='ONERROR RAN'">
<svg xmlns="http://www.w3.org/2000/svg"><animate onbegin="document.getElementById('out').textContent='SVG ANIMATE RAN'" attributeName="x" dur="1s"/></svg>
<body></html>`;

const PARENT = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<iframe id="skin" src="/skin.html" sandbox="allow-same-origin"></iframe>
<iframe id="control" src="/skin.html"></iframe>
</body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(req.url.startsWith('/skin') ? SKIN : PARENT);
});

(async () => {
  await new Promise(r => server.listen(8799, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newPage();
  const results = [];
  const log = (n, ok, d) => results.push([ok ? 'PASS' : 'FAIL', n, d]);

  await page.goto('http://127.0.0.1:8799/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  const read = id => page.evaluate(i => {
    const f = document.getElementById(i);
    try { return f.contentDocument.getElementById('out').textContent; }
    catch (e) { return 'THREW: ' + e.message; }
  }, id);

  // A. CONTROL — an ordinary same-origin iframe must run its inline script.
  const control = await read('control');
  log('CONTROL: unsandboxed iframe runs inline <script>', control === 'INLINE SCRIPT RAN', `#out = "${control}"`);

  // B. sandbox without allow-scripts: script, onerror, SVG animate all inert
  const sandboxed = await read('skin');
  log('sandbox w/o allow-scripts blocks <script>, onerror, SVG animate', sandboxed === 'unbound', `#out = "${sandboxed}"`);

  // C. parent can READ the sandboxed DOM (hook discovery)
  const hooks = await page.evaluate(() =>
    document.getElementById('skin').contentDocument.querySelectorAll('[data-que-bind],[data-que-action]').length);
  log('parent reads sandboxed iframe DOM (data-que-* discovery)', hooks === 2, `found ${hooks} hooks`);

  // D. parent can WRITE into it (binding engine)
  const written = await page.evaluate(() => {
    const d = document.getElementById('skin').contentDocument;
    d.querySelector('[data-que-bind="title"]').textContent = 'Blade Runner';
    return d.getElementById('out').textContent;
  });
  log('parent writes into sandboxed iframe DOM (binding engine)', written === 'Blade Runner', `#out = "${written}"`);

  // E. parent-attached listeners fire (action engine)
  const clicked = await page.evaluate(() => {
    const d = document.getElementById('skin').contentDocument;
    let fired = false;
    const b = d.querySelector('[data-que-action="play"]');
    b.addEventListener('click', () => { fired = true; });
    b.click();
    return fired;
  });
  log('parent-attached listener fires in sandboxed iframe (action engine)', clicked, String(clicked));

  // F. THE CRITICAL ONE — a <script> the parent injects must NOT execute
  const injected = await page.evaluate(async () => {
    const d = document.getElementById('skin').contentDocument;
    const s = d.createElement('script');
    s.textContent = 'document.getElementById("out").textContent = "PARENT-INJECTED SCRIPT RAN";';
    d.body.appendChild(s);
    await new Promise(r => setTimeout(r, 400));
    return d.getElementById('out').textContent;
  });
  log('parent-injected <script> does NOT execute in sandboxed frame', injected !== 'PARENT-INJECTED SCRIPT RAN', `#out = "${injected}"`);

  // G. same check against the UNSANDBOXED control — injection there SHOULD run
  const injectedControl = await page.evaluate(async () => {
    const d = document.getElementById('control').contentDocument;
    const s = d.createElement('script');
    s.textContent = 'document.getElementById("out").textContent = "PARENT-INJECTED SCRIPT RAN";';
    d.body.appendChild(s);
    await new Promise(r => setTimeout(r, 400));
    return d.getElementById('out').textContent;
  });
  log('CONTROL: parent-injected <script> DOES execute without sandbox',
      injectedControl === 'PARENT-INJECTED SCRIPT RAN', `#out = "${injectedControl}"`);

  // H. skin CSS still applies
  const styled = await page.evaluate(() => {
    const d = document.getElementById('skin').contentDocument;
    const st = d.createElement('style');
    st.textContent = '#out{color:rgb(1,2,3)}';
    d.head.appendChild(st);
    return d.defaultView.getComputedStyle(d.getElementById('out')).color;
  });
  log('CSS applies inside the sandboxed frame (skins can style)', styled === 'rgb(1, 2, 3)', styled);

  // I. does a CSP of script-src 'none' on the frame change anything? (third layer)
  log('sandbox flags present on frame', await page.evaluate(() =>
    document.getElementById('skin').getAttribute('sandbox')) === 'allow-same-origin', 'sandbox="allow-same-origin"');

  const pad = Math.max(...results.map(r => r[1].length));
  for (const [v, n, d] of results) console.log(`${v}  ${n.padEnd(pad)}  ${d}`);
  console.log('\nChromium ' + browser.version());
  console.log(results.filter(r => r[0] === 'FAIL').length + ' failures of ' + results.length);
  await browser.close();
  server.close();
})();
