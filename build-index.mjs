import algoliasearch from "algoliasearch";
import { chromium, devices } from "playwright";
import { XMLParser } from "fast-xml-parser";

const APP_ID   = process.env.ALGOLIA_APP_ID;
const ADMIN    = process.env.ALGOLIA_ADMIN_API_KEY;
const INDEX    = process.env.ALGOLIA_INDEX_NAME || "iff_pages";
const SITEMAP  = process.env.SITEMAP_URL || "https://ifftrendtakeover.com/sitemap.xml";

if (!APP_ID || !ADMIN) throw new Error("Missing Algolia credentials");

const client = algoliasearch(APP_ID, ADMIN);
const index  = client.initIndex(INDEX);

async function urlsFromSitemap(url){
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sitemap fetch failed: ${res.status}`);
  const xml = await res.text();
  const p = new XMLParser();
  const d = p.parse(xml);

  // Gère sitemap index et urlset
  const list = []
    .concat(d?.urlset?.url || [], d?.sitemapindex?.sitemap || [])
    .map(n => (n.loc || "").trim())
    .filter(u => u && u.startsWith("https://ifftrendtakeover.com") && !u.endsWith(".xml"));

  return [...new Set(list)];
}

function splitContent(s){
  return s.split(/\n{2,}|\. (?=[A-ZÀ-ÖØ-Þ0-9])/).map(t => t.trim()).filter(Boolean);
}

async function extractMobile(url, page){
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1500); // laisse Readymag injecter
  const data = await page.evaluate(() => {
    const canon = document.querySelector('link[rel="canonical"]')?.href || location.href;
    const title = document.querySelector("h1")?.textContent?.trim() || document.title || canon;
    const scope = document.querySelector("main") || document.body;
    const texts = Array.from(scope.querySelectorAll("h1,h2,h3,p,li,blockquote"))
      .map(el => (el.textContent || "").trim())
      .filter(Boolean);
    return { canon, title, body: texts.join("\n").trim() };
  });
  if (!data.body || data.body.length < 80) return [];
  return splitContent(data.body).map((c, i) => ({
    objectID: `${data.canon}#${i}`,
    url: data.canon,
    title: data.title,
    content: c,
    device: "mobile"
  }));
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    ...devices["iPhone 13"],
    viewport: { width: 390, height: 844 }
  });
  const page = await ctx.newPage();

  const urls = await urlsFromSitemap(SITEMAP);
  const all = [];
  for (const u of urls) {
    try {
      const recs = await extractMobile(u, page);
      console.log("OK", u, "→", recs.length, "records");
      all.push(...recs);
    } catch (e) {
      console.warn("FAIL", u, e.message);
    }
  }
  if (!all.length) throw new Error("No records found");
  await index.saveObjects(all);
  console.log("Pushed", all.length, "records to", INDEX);
  await browser.close();
})();
