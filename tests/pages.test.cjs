'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { start } = require('../server.cjs');

test('pages.js browser pagination contract (tables, underscores, overflow, placements)', { timeout: 45000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-pages-test-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const server = await start({ port: 0, dataDir, env: {} });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const contractCode = await fs.readFile(path.join(__dirname, 'pages.browser.mjs'), 'utf8');
  const browser = await chromium.launch({
    executablePath: process.env.FOLIO_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.route(origin + '/__pages_contract__.mjs', route =>
    route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: contractCode })
  );
  await page.goto(origin);
  const summary = await page.evaluate(async () => {
    const [{ buildPages }, { checkPages }] = await Promise.all([
      import('/pages.js'),
      import('/__pages_contract__.mjs')
    ]);
    return checkPages(buildPages);
  });
  assert.ok(summary.passed >= 15, `expected >= 15 pagination checks, got ${summary.passed}`);
});
