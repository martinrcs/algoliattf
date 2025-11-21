// index.mjs — indexation MOBILE par blocs, sans doublons
import { chromium } from 'playwright';
import algoliasearch from 'algoliasearch'; // v4

const BASE = process.env.BASE_URL || 'https://ifftrendtakeover.com';
const SITEMAP = `${BASE}/sitemap.xml`;

const APP_ID = process.env.ALGOLIA_APP_ID || process.env.ALGOLIA_APPLICATION_ID;
const ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY || process.env.ALGOLIA_ADMIN_API_KEY;
const INDEX_NAME = process.env.ALGOLIA_INDEX || 'iff_blocks';

if (!APP_ID || !ADMIN_KEY) throw new Error('Algolia creds manquants (APP_ID/ADMIN_KEY)');

const client = algoliasearch(APP_ID, ADMIN_KEY);
const index = client.initIndex(INDEX_NAME);

function hash(s){ let h=2166136261>>>0; for (let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619);} return (h>>>0).toString(36); }
const norm = s => (s||'').replace(/[\u200B\u200C\u200D]/g,'').replace(/\u00AD/g,'').replace(/[\u00A0\u202F]/g,' ').replace(/\s+/g,' ').trim();

async function fetchUrls(){
  try{
    const r = await fetch(SITEMAP); if(!r.ok) throw 0;
    const txt = await r.text();
    const urls = Array.from(txt.matchAll(/<loc>(.*?)<\/loc>/g)).map(m=>m[1]);
    if (urls.length) return urls;
  }catch{}
  return [BASE,`${BASE}/2/`,`${BASE}/3/`,`${BASE}/4/`,`${BASE}/5/`,`${BASE}/6/`,`${BASE}/7/`];
}

async function extractBlocks(frame){
  return frame.evaluate(() => {
    const hidden = (el) => {
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      return cs.display==='none' || cs.visibility==='hidden' || +cs.opacity===0 || r.width===0 || r.height===0;
    };
    const scope = document.querySelector('main') || document.body;

    // Candidats: uniquement des blocs sémantiques
    const C = Array.from(scope.querySelectorAll([
      'h1','h2','h3','h4',
      'p','li','blockquote',
      '.rm-text','[data-rm-text]'
    ].join(',')));

    // Écarter les ancêtres contenant déjà des sous-blocs (évite doublons)
    const hasSubBlock = (el) => el.querySelector('p,li,blockquote,h1,h2,h3,h4');
    const BAD = /(^| )(mag-pages-container|pages-container|above-pages-container|rm-root|container)( |$)/;

    const out = [];
    let order = 0;

    for (const el of C){
      if (hidden(el)) continue;
      if (BAD.test(el.className||'') || BAD.test(el.parentElement?.className||'')) continue;
      if (el !== document && hasSubBlock(el) && !el.matches('li')) continue; // garde <li>, écarte gros wrappers
      const txt = (el.textContent || '').replace(/\s+/g,' ').trim();
      if (!txt) continue;
      if (txt.length > 6000) continue; // coupe bruit massif
      out.push({ order: order++, text: txt });
    }
    const title = document.title || '';
    return { title, blocks: out };
  });
}

async function run(){
  const urls = await fetchUrls();

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 800 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3, isMobile: true, hasTouch: true
  });
  const page = await context.newPage();

  const all = [];

  for (const url of urls){
    try{
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(()=>{});
      await page.waitForTimeout(900);

      const rm = page.frames().find(f => /rmcdn|readymag/.test(f.url())) || page.mainFrame();
      const { title, blocks } = await extractBlocks(rm);

      // déduplication stricte par contenu normalisé dans la page
      const seen = new Set();
      const recs = [];
      let order = 0;
      for (const b of blocks){
        const content = norm(b.text);
        if (!content) continue;
        const key = content; // par contenu
        if (seen.has(key)) continue;
        seen.add(key);

        const anchor = content.slice(0, 160);
        const objectID = hash(url + '|' + order + '|' + anchor);
        recs.push({ objectID, url, title, device:'mobile', order, content, anchor });
        order++;
      }
      all.push(...recs);
      console.log('OK', url, recs.length, 'blocs');
    }catch(e){
      console.error('KO', url, e.message);
    }
  }

  if (all.length){
    await index.setSettings({
      distinct: false,
      searchableAttributes: ['content','title','url'],
      customRanking: ['asc(order)'],
      attributesForFaceting: ['device']
    });
    // remplace l'index pour éviter les vieux doublons
    await index.replaceAllObjects(all, { autoGenerateObjectIDIfNotExist: false });
    console.log('Indexed', all.length, 'records');
  }else{
    console.warn('Aucun record généré');
  }

  await browser.close();
}

run().catch(e => { console.error(e); process.exit(1); });
