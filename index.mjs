// index.mjs — indexation par blocs (mobile) vers Algolia
import { chromium } from 'playwright';
import algoliasearch from 'algoliasearch';

const BASE = process.env.BASE_URL || 'https://ifftrendtakeover.com';
const SITEMAP = `${BASE}/sitemap.xml`;
const APP_ID = process.env.ALGOLIA_APP_ID;
const ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY;         // <- ADMIN key (écriture)
const INDEX_NAME = process.env.ALGOLIA_INDEX || 'iff_blocks';

if (!APP_ID || !ADMIN_KEY) throw new Error('Algolia creds manquants');

const client = algoliasearch(APP_ID, ADMIN_KEY);
const index = client.initIndex(INDEX_NAME);

function hash(s) {
  let h = 2166136261 >>> 0;
  for (let i=0; i<s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h>>>0).toString(36);
}

async function fetchUrls() {
  const txt = await fetch(SITEMAP).then(r => r.ok ? r.text() : '');
  const urls = Array.from(txt.matchAll(/<loc>(.*?)<\/loc>/g)).map(m => m[1]);
  if (urls.length) return urls;
  // fallback simple
  return [BASE, `${BASE}/2/`, `${BASE}/3/`, `${BASE}/4/`, `${BASE}/5/`, `${BASE}/6/`, `${BASE}/7/`];
}

function normalize(s){
  return (s||'')
    .replace(/[\u200B\u200C\u200D]/g,'')   // zero-width
    .replace(/\u00AD/g,'')                 // soft hyphen
    .replace(/[\u00A0\u202F]/g,' ')        // NBSP
    .replace(/\s+/g,' ')
    .trim();
}

async function extractBlocks(frame){
  return await frame.evaluate(() => {
    const HIDE = (el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display==='none' || cs.visibility==='hidden' || +cs.opacity===0 || r.width===0 || r.height===0;
    };
    const scope = document.querySelector('main') || document.body;
    const sels = ['h1','h2','h3','h4','p','li','blockquote','.rm-text','[data-rm-text]','span','div'];
    const nodes = Array.from(scope.querySelectorAll(sels.join(',')));

    const title = document.title || '';
    const out = [];
    let order = 0;
    for (const el of nodes){
      if (HIDE(el)) continue;
      const txt = (el.textContent || '').replace(/\s+/g,' ').trim();
      if (!txt) continue;
      // évite les mega-containers vides de sens
      if (txt.length < 2 || txt.length > 10000) continue;
      out.push({ order: order++, text: txt });
    }
    return { title, blocks: out };
  });
}

async function run() {
  const urls = await fetchUrls();

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 800 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });

  const page = await context.newPage();

  const allRecords = [];

  for (const url of urls){
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(1800);

      // trouve la frame Readymag si présente, sinon main
      const frame = page.frames().find(f =>
        /rmcdn|readymag/.test(f.url())
      ) || page.mainFrame();

      const { title, blocks } = await extractBlocks(frame);

      const recs = blocks.map(b => {
        const content = normalize(b.text);
        const anchor = content.slice(0, 120); // fragment d’ancre
        const objectID = hash(url + '|' + b.order + '|' + anchor);
        return {
          objectID,
          url,
          title,
          device: 'mobile',
          order: b.order,
          content,
          anchor,             // utilisé pour rmfind
        };
      });

      allRecords.push(...recs);
      console.log('OK', url, recs.length, 'blocs');
    } catch (e){
      console.error('KO', url, e.message);
    }
  }

  if (allRecords.length){
    await index.saveObjects(allRecords, { autoGenerateObjectIDIfNotExist: false });
    console.log('Indexed', allRecords.length, 'records');
  }

  await browser.close();
}

run().catch(e => { console.error(e); process.exit(1); });
