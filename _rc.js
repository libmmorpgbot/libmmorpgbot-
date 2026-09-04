const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ headless: true, executablePath: '/opt/pw-browsers/chromium' });
  const p = await b.newPage();
  await p.goto('http://127.0.0.1:8820/render-check', { waitUntil: 'load' });
  await p.waitForFunction(String.raw`/^render-check (OK|FAIL)/.test(document.title)`, null, { timeout: 240000 });
  const txt = await p.$eval('#out', e => e.innerText);
  console.log('TITLE:', await p.title());
  console.log(txt.split('\n').filter(l => /АВТО у VIP|FAIL|ПРОШЛО|УПАЛО/.test(l)).join('\n'));
  await b.close();
})();
