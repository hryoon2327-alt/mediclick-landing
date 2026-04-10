/**
 * Mediclick – Site Analyzer Backend
 * POST /api/analyze  { url: "https://..." }
 * GET  /             serves index.html
 *
 * Analysis pipeline:
 *  1. Fetch HTML (server-side, no CORS)
 *  2. Fetch external CSS files in parallel (max 6)
 *  3. Parse HTML with Cheerio + CSS with regex
 *  4. Score 5 axes with real data
 */

const express = require('express');
const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

/* ════════════════════════════════════════════════════════════════
   FETCH HELPERS
════════════════════════════════════════════════════════════════ */

const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'ja,en;q=0.9',
};

/** Fetch HTML with charset detection */
async function fetchHTML(url) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  const t0    = Date.now();

  const res = await fetch(url, {
    signal:  ctrl.signal,
    headers: { ...COMMON_HEADERS, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    redirect: 'follow',
  });
  clearTimeout(timer);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const buf = await res.buffer();
  let html  = buf.toString('utf-8');

  // Detect Shift-JIS / EUC-JP
  const m = /<meta[^>]+charset=["']?([^"'\s;>]+)/i.exec(html) ||
            /<meta[^>]+content=["'][^"']*charset=([^"'\s;>]+)/i.exec(html);
  if (m) {
    const cs = m[1].toLowerCase().replace('_', '-');
    try {
      if (cs.includes('shift') || cs === 'sjis') {
        html = new (require('util').TextDecoder)('shift-jis').decode(buf);
      } else if (cs.includes('euc')) {
        html = new (require('util').TextDecoder)('euc-jp').decode(buf);
      }
    } catch (_) {}
  }

  return { html, fetchTime: Date.now() - t0, finalUrl: res.url };
}

/** Resolve a CSS href to an absolute URL */
function resolveUrl(href, base) {
  try { return new URL(href, base).href; } catch (_) { return null; }
}

/** Fetch a single CSS file, return text or null */
async function fetchOneCss(url) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url, {
      signal:  ctrl.signal,
      headers: { ...COMMON_HEADERS, Accept: 'text/css,*/*;q=0.1' },
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    // Accept text/css OR anything that might be CSS (some servers return text/plain)
    if (!ct.includes('css') && !ct.includes('text') && !ct.includes('octet')) return null;
    const text = await res.text();
    return text.length > 5 ? text : null;
  } catch (_) {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Extract all <link rel="stylesheet"> hrefs from HTML,
 * fetch up to MAX_CSS in parallel, return combined CSS string.
 */
const MAX_CSS = 6;

async function fetchCSSFiles($, baseUrl) {
  const hrefs = [];
  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) hrefs.push(href);
  });

  // Also pick up @import inside <style> blocks
  $('style').each((_, el) => {
    const content = $(el).html() || '';
    const imports = [...content.matchAll(/@import\s+["']([^"']+)["']/g)];
    imports.forEach(m => hrefs.push(m[1]));
  });

  const uniqueHrefs = [...new Set(hrefs)].slice(0, MAX_CSS);
  const urls = uniqueHrefs.map(h => resolveUrl(h, baseUrl)).filter(Boolean);

  if (urls.length === 0) return { combined: '', files: [] };

  const results = await Promise.all(urls.map(u => fetchOneCss(u)));
  const files   = urls.map((u, i) => ({ url: u, fetched: results[i] !== null }));
  const combined = results.filter(Boolean).join('\n');

  return { combined, files, count: urls.length, fetched: files.filter(f => f.fetched).length };
}

/* ════════════════════════════════════════════════════════════════
   ANALYZERS
════════════════════════════════════════════════════════════════ */

function analyzeMeta($) {
  return {
    title:      $('title').first().text().trim() || null,
    desc:       $('meta[name="description"]').attr('content')?.trim() || null,
    viewport:   $('meta[name="viewport"]').attr('content')?.trim() || null,
    canonical:  $('link[rel="canonical"]').attr('href')?.trim() || null,
    robots:     $('meta[name="robots"]').attr('content')?.trim() || null,
    ogTitle:    $('meta[property="og:title"]').attr('content')?.trim() || null,
    ogDesc:     $('meta[property="og:description"]').attr('content')?.trim() || null,
    ogImage:    $('meta[property="og:image"]').attr('content')?.trim() || null,
    ogType:     $('meta[property="og:type"]').attr('content')?.trim() || null,
    charset:    $('meta[charset]').attr('charset') || null,
    themeColor: $('meta[name="theme-color"]').attr('content') || null,
  };
}

function analyzeSchema(html) {
  const blocks = [...html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )];
  const schemas = [];
  blocks.forEach(m => {
    try {
      const raw   = JSON.parse(m[1]);
      const items = Array.isArray(raw) ? raw : [raw];
      items.forEach(item => schemas.push({
        type:            item['@type'] || 'Unknown',
        hasTelephone:    !!item.telephone,
        hasAddress:      !!item.address,
        hasOpeningHours: !!(item.openingHours || item.openingHoursSpecification),
        hasName:         !!item.name,
        hasGeo:          !!item.geo,
        rawName:         item.name     || null,
        rawTel:          item.telephone || null,
      }));
    } catch (_) {}
  });

  const medicalTypes = [
    'MedicalOrganization','Physician','MedicalClinic',
    'Hospital','Dentist','MedicalBusiness',
  ];
  return {
    count:       schemas.length,
    schemas,
    hasMedical:  schemas.some(s => medicalTypes.includes(s.type)),
    hasLocalBiz: schemas.some(s => s.type === 'LocalBusiness' || medicalTypes.includes(s.type)),
    hasPhone:    schemas.some(s => s.hasTelephone),
    hasHours:    schemas.some(s => s.hasOpeningHours),
    types:       schemas.map(s => s.type).join(', '),
    clinicName:  schemas.find(s => s.rawName)?.rawName || null,
    schemaTel:   schemas.find(s => s.rawTel)?.rawTel   || null,
  };
}

function analyzeHeadings($) {
  const list = sel => $(sel).map((_, el) =>
    $(el).text().trim().replace(/\s+/g, ' ').slice(0, 80)
  ).get();
  const h1 = list('h1'), h2 = list('h2'), h3 = list('h3');
  return { h1, h2, h3, h1Count: h1.length, h2Count: h2.length, h3Count: h3.length };
}

function analyzeImages($) {
  const imgs    = $('img').toArray();
  const withAlt = imgs.filter(el => {
    const alt = $(el).attr('alt');
    return alt !== undefined && alt.trim().length > 0;
  });
  return {
    total:      imgs.length,
    withAlt:    withAlt.length,
    withoutAlt: imgs.length - withAlt.length,
    altRatio:   imgs.length > 0 ? Math.round((withAlt.length / imgs.length) * 100) : 0,
  };
}

/** Analyse inline <style> + fetched external CSS together */
function analyzeCSS($, externalCSS) {
  // Inline <style> content
  let inlineStyles = '';
  $('style').each((_, el) => { inlineStyles += ($('*', el).html() || $(el).html() || '') + '\n'; });

  const all = inlineStyles + '\n' + externalCSS; // combined source

  // ── @media queries ──
  const mediaMatches  = [...all.matchAll(/@media\s*([^{]+)\{/g)];
  const mediaCount    = mediaMatches.length;
  // Extract min-width / max-width breakpoints
  const bpSet = new Set();
  mediaMatches.forEach(m => {
    const bp = [...m[1].matchAll(/(?:min|max)-width\s*:\s*([\d.]+(?:px|em|rem))/gi)];
    bp.forEach(b => bpSet.add(b[1]));
  });
  const breakpoints = [...bpSet].sort();

  // ── Layout signals ──
  const hasFlexbox      = /display\s*:\s*flex/i.test(all);
  const hasGrid         = /display\s*:\s*grid/i.test(all);
  const hasViewportUnits= /\b\d+(?:\.\d+)?(?:vw|vh|vmin|vmax)\b/i.test(all);
  const hasMaxWidth     = /max-width\s*:/i.test(all);
  const hasMinWidth     = /min-width\s*:/i.test(all);
  const hasCssVars      = /--[\w-]+\s*:/i.test(all); // CSS custom properties = modern

  // ── Fixed-width anti-patterns ──
  // Look for px widths on element selectors (not inside @media)
  // Strip @media blocks first to avoid false positives
  const noMediaCss   = all.replace(/@media[^{]*\{[\s\S]*?\}\s*\}/g, '');
  const fixedWidths  = [...noMediaCss.matchAll(/(?:^|[,;}])\s*(?:body|\.wrapper|\.container|#wrap|#content)[^{]*\{[^}]*width\s*:\s*(\d{3,})px/gi)];
  const hasFixedBody = fixedWidths.length > 0;

  // ── Font readability ──
  // Base font-size: ideally 14px-18px
  const fontMatch    = /body[^{]*\{[^}]*font-size\s*:\s*([\d.]+)(px|rem|em)/i.exec(noMediaCss);
  const baseFontSize = fontMatch ? { value: parseFloat(fontMatch[1]), unit: fontMatch[2] } : null;

  return {
    mediaCount,
    breakpoints,
    hasMediaQuery:     mediaCount > 0,
    hasFlexbox,
    hasGrid,
    hasViewportUnits,
    hasMaxWidth,
    hasMinWidth,
    hasCssVars,
    hasFixedBody,
    baseFontSize,
    externalFilesAnalyzed: externalCSS.length > 0,
    totalCssSize:   Math.round(all.length / 1024),
  };
}

function analyzeResponsive($, html) {
  const vp        = $('meta[name="viewport"]');
  const vpContent = vp.attr('content') || '';
  return {
    hasViewport:        vp.length > 0,
    hasWidthDevice:     vpContent.includes('width=device-width'),
    hasInitialScale:    vpContent.includes('initial-scale=1'),
    hasMediaQueryHtml:  /@media[\s(]/i.test(html),   // inline only
    hasPicture:         $('picture').length > 0,
    hasFixedWidthTable: /\<table[^>]+width=["']\d{3,}["']/i.test(html),
    viewportContent:    vpContent,
  };
}

function analyzeCTA($, html) {
  const telEls  = $('a[href^="tel:"]').toArray();
  const telNums = [...new Set(
    telEls.map(el => ($(el).attr('href') || '').replace('tel:', '').replace(/[^\d-+()\s]/g, '').trim())
  )].filter(Boolean).slice(0, 5);

  const kwBook    = ['予約','受診','診察予約','Web予約','WEB予約','ウェブ予約','オンライン予約','来院予約'];
  const kwContact = ['問い合わせ','お問合せ','お問い合わせ','ご連絡','contact'];
  const kwAccess  = ['アクセス','地図','MAP','交通','駐車場'];
  const kwHours   = ['診療時間','受付時間','診察時間'];
  const has       = kws => kws.some(k => html.includes(k));

  const ctaLinks = $('a, button').toArray().filter(el => {
    const t = $(el).text().trim();
    return kwBook.some(k => t.includes(k)) || kwContact.some(k => t.includes(k));
  });

  const hasOnlineBooking =
    /airreserve|reserva\.jp|coubic|clinicforce|eparkbyoin|haisha-navi|epark/i.test(html);

  return {
    telCount:         telEls.length,
    telNums,
    formCount:        $('form').length,
    hasBooking:       has(kwBook),
    hasContact:       has(kwContact),
    hasAccess:        has(kwAccess),
    hasHours:         has(kwHours),
    ctaLinkCount:     ctaLinks.length,
    hasOnlineBooking,
  };
}

function analyzePerformance(html, fetchTime) {
  return {
    sizeKB:     Math.round(html.length / 1024),
    fetchTime,
    extScripts: (html.match(/<script[^>]+src=/gi) || []).length,
    extStyles:  (html.match(/<link[^>]+rel=["']stylesheet["']/gi) || []).length,
    inlineScr:  (html.match(/<script(?![^>]*src=)[^>]*>/gi) || []).length,
    hasPreconn: /<link[^>]+rel=["']preconnect["']/i.test(html),
    hasPreload: /<link[^>]+rel=["']preload["']/i.test(html),
  };
}

/* ════════════════════════════════════════════════════════════════
   SCORE CALCULATOR  v2  – calibrated against real clinic sites
   Design goals:
     - Average clinic site  → 35–58 overall
     - Well-optimized site  → 60–75 overall
     - Near-perfect site    → 80–92 overall
   Key principle: missing critical elements cause real score drops,
   not just "no bonus". Penalties are explicit.
════════════════════════════════════════════════════════════════ */

function calculateScores({ meta, schema, headings, images, responsive, css, cta, perf }) {

  /* ── UI/UX ─────────────────────────────────────────────────
     Evaluates brand expression, SEO metadata, visual quality.
     Max achievable ≈ 95. Typical good site ≈ 55–70.
  ────────────────────────────────────────────────────────── */
  let uiux = 0;

  // Title
  if (meta.title) uiux += 8;
  if (meta.title && meta.title.length >= 20 && meta.title.length <= 65) uiux += 6;
  else if (meta.title) uiux += 2;   // too short or too long

  // Meta description
  if (meta.desc) uiux += 10;
  if (meta.desc && meta.desc.length >= 80 && meta.desc.length <= 160) uiux += 8;
  else if (meta.desc && meta.desc.length >= 50) uiux += 2; // too short
  // PENALTY: no description at all
  if (!meta.desc) uiux -= 4;

  // OGP
  if (meta.ogTitle) uiux += 7;
  if (meta.ogImage) uiux += 10;  // critical for SNS sharing
  if (meta.ogDesc)  uiux += 4;
  if (meta.ogTitle && meta.ogDesc && meta.ogImage) uiux += 4; // full OGP bonus

  // Images & alt text
  if (images.total > 0) uiux += 4;
  uiux += Math.round(12 * (images.altRatio / 100)); // 0–12 pts based on actual ratio
  // PENALTY: images exist but zero alt tags
  if (images.total >= 3 && images.altRatio === 0) uiux -= 8;

  // H1 structure (critical for page identity)
  if (headings.h1Count === 1)      uiux += 12; // ideal
  else if (headings.h1Count > 1)   uiux += 3;  // multiple H1 = bad practice
  else                              uiux -= 10; // PENALTY: no H1

  // Basic hygiene
  if (meta.charset) uiux += 3;
  if (meta.title && meta.desc) uiux += 4; // both present = SEO baseline OK

  /* ── Usability ──────────────────────────────────────────────
     Evaluates how easily visitors can navigate and use the site.
     Max achievable ≈ 95. Typical good site ≈ 45–65.
  ────────────────────────────────────────────────────────── */
  let usability = 0;

  // Viewport / responsive baseline
  if (responsive.hasViewport)     usability += 12;
  if (responsive.hasWidthDevice)  usability += 8;
  if (responsive.hasInitialScale) usability += 5;

  // Heading structure (directly affects navigability)
  if (headings.h1Count === 1)    usability += 12;
  else if (headings.h1Count > 1) usability += 3;
  else                            usability -= 10; // PENALTY: no H1
  if (headings.h2Count >= 3)     usability += 10;
  else if (headings.h2Count >= 1) usability += 5;

  // Accessibility: image alt text (heavily weighted)
  usability += Math.round(20 * (images.altRatio / 100)); // 0–20 pts
  // PENALTY: zero alt on a content-heavy page
  if (images.total >= 3 && images.altRatio === 0) usability -= 8;

  // Performance
  if (perf.fetchTime < 2000)      usability += 12;
  else if (perf.fetchTime < 4000) usability += 7;
  else if (perf.fetchTime < 7000) usability += 3;
  // PENALTY: very slow
  if (perf.fetchTime >= 7000)     usability -= 5;

  // Page weight
  if (perf.sizeKB < 100)         usability += 8;
  else if (perf.sizeKB < 300)    usability += 4;
  else if (perf.sizeKB > 800)    usability -= 5; // PENALTY: bloated page

  /* ── 情報設計 ──────────────────────────────────────────────
     Evaluates content architecture, SEO structure, Schema.org.
     Max achievable ≈ 98. Typical good site ≈ 40–62.
  ────────────────────────────────────────────────────────── */
  let ia = 0;

  // Heading hierarchy
  if (headings.h1Count > 0)      ia += 10;
  if (headings.h2Count >= 3)     ia += 12;
  else if (headings.h2Count >= 1) ia += 6;
  if (headings.h3Count > 0)      ia += 5;

  // Meta quality
  if (meta.desc)                              ia += 10;
  if (meta.desc && meta.desc.length >= 80)    ia += 6;
  if (meta.title && meta.title.length > 15)   ia += 8;

  // Schema.org – most important for local clinic SEO
  if (schema.count > 0)                        ia += 20;
  if (schema.hasMedical || schema.hasLocalBiz) ia += 10; // clinic-specific bonus
  if (schema.hasPhone)                         ia += 5;
  if (schema.hasHours)                         ia += 5;
  // PENALTY: no schema at all
  if (schema.count === 0) ia -= 5;

  // Technical SEO
  if (meta.canonical) ia += 10;
  if (!meta.robots || !meta.robots.includes('noindex')) ia += 4;

  // Content richness
  if (perf.sizeKB > 50) ia += 5;

  /* ── 集患導線 ──────────────────────────────────────────────
     Evaluates patient acquisition path: phone, booking, hours.
     Max achievable ≈ 98. Typical good clinic site ≈ 45–70.
  ────────────────────────────────────────────────────────── */
  let ctaScore = 0;

  // Phone contact (most critical for clinics)
  if (cta.telCount > 0)  ctaScore += 22;
  if (cta.telCount >= 2) ctaScore += 5;  // multiple touchpoints
  // PENALTY: no phone link at all
  if (cta.telCount === 0) ctaScore -= 5;

  // Booking / forms
  if (cta.formCount > 0)        ctaScore += 18;
  if (cta.hasOnlineBooking)     ctaScore += 8;

  // Keywords on page
  if (cta.hasBooking)           ctaScore += 12;
  if (cta.hasContact)           ctaScore += 8;
  if (cta.hasAccess)            ctaScore += 8;
  if (cta.hasHours)             ctaScore += 10; // hours = critical for clinics
  // PENALTY: no hours information
  if (!cta.hasHours) ctaScore -= 5;

  // CTA link count
  if (cta.ctaLinkCount >= 3)    ctaScore += 7;
  else if (cta.ctaLinkCount >= 1) ctaScore += 3;

  /* ── モバイル対応 ────────────────────────────────────────────
     Now uses REAL CSS data from fetched external stylesheets.
     Max achievable ≈ 92. Typical modern site ≈ 55–80.
  ────────────────────────────────────────────────────────── */
  let mobile = 0;

  // Viewport meta (basic requirement)
  if (responsive.hasViewport)     mobile += 16;
  if (responsive.hasWidthDevice)  mobile += 10;
  if (responsive.hasInitialScale) mobile += 5;
  // PENALTY: no viewport at all = not responsive
  if (!responsive.hasViewport)    mobile -= 15;

  // @media queries – graded by count (from real CSS files)
  if (css.hasMediaQuery) {
    if      (css.mediaCount >= 10) mobile += 20;
    else if (css.mediaCount >= 5)  mobile += 16;
    else if (css.mediaCount >= 2)  mobile += 10;
    else                           mobile += 5;
  } else if (responsive.hasMediaQueryHtml) {
    mobile += 4; // only inline style found
  } else {
    mobile -= 10; // PENALTY: no media queries at all
  }

  // CSS layout quality (from fetched CSS)
  if (css.hasFlexbox || css.hasGrid) mobile += 10;
  if (css.hasFlexbox && css.hasGrid) mobile += 4;  // modern layout stack
  if (css.hasMaxWidth)               mobile += 5;
  if (css.hasViewportUnits)          mobile += 4;
  if (css.hasCssVars)                mobile += 3;  // modern CSS indicator

  // Penalties from CSS analysis
  if (responsive.hasFixedWidthTable) mobile -= 10;
  if (css.hasFixedBody)              mobile -= 8;

  return {
    uiux:      Math.min(100, Math.max(0, uiux)),
    usability: Math.min(100, Math.max(0, usability)),
    ia:        Math.min(100, Math.max(0, ia)),
    cta:       Math.min(100, Math.max(0, ctaScore)),
    mobile:    Math.min(100, Math.max(0, mobile)),
  };
}

/* ════════════════════════════════════════════════════════════════
   API ENDPOINT
════════════════════════════════════════════════════════════════ */

app.post('/api/analyze', async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!url.startsWith('http')) url = 'https://' + url;

  try {
    // Step 1 – fetch HTML
    const { html, fetchTime, finalUrl } = await fetchHTML(url);
    const $ = cheerio.load(html);

    // Step 2 – fetch CSS files in parallel while running HTML analysis
    const [cssResult, meta, schema, headings, images, responsive, cta, perf] = await Promise.all([
      fetchCSSFiles($, finalUrl || url),
      Promise.resolve(analyzeMeta($)),
      Promise.resolve(analyzeSchema(html)),
      Promise.resolve(analyzeHeadings($)),
      Promise.resolve(analyzeImages($)),
      Promise.resolve(analyzeResponsive($, html)),
      Promise.resolve(analyzeCTA($, html)),
      Promise.resolve(analyzePerformance(html, fetchTime)),
    ]);

    // Step 3 – analyse combined CSS
    const css = analyzeCSS($, cssResult.combined);

    // Step 4 – score
    const scores = calculateScores({ meta, schema, headings, images, responsive, css, cta, perf });

    res.json({
      ok: true,
      url: finalUrl || url,
      fetchTime,
      scores,
      findings: { meta, schema, headings, images, responsive, css, cta, perf,
                  cssFiles: cssResult.files },
    });

  } catch (err) {
    console.error('[analyze]', url, err.message);
    res.status(200).json({
      ok: false,
      url,
      error: err.message,
      errorType:
        err.name === 'AbortError'                      ? 'timeout'      :
        /certificate|ssl/i.test(err.message)           ? 'ssl'          :
        /ENOTFOUND|ECONNREFUSED/.test(err.message)     ? 'dns'          :
        'fetch_failed',
    });
  }
});

/* ════════════════════════════════════════════════════════════════
   LEADS STORAGE
════════════════════════════════════════════════════════════════ */

const LEADS_DIR  = path.join(__dirname, 'data');
const LEADS_FILE = path.join(LEADS_DIR, 'leads.json');

// Ensure data directory and file exist on startup
if (!fs.existsSync(LEADS_DIR)) fs.mkdirSync(LEADS_DIR, { recursive: true });
if (!fs.existsSync(LEADS_FILE)) fs.writeFileSync(LEADS_FILE, '[]', 'utf-8');

function readLeads() {
  try { return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf-8')); }
  catch (_) { return []; }
}

function writeLeads(leads) {
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), 'utf-8');
}

/* POST /api/leads — save consultation request + analysis data */
app.post('/api/leads', (req, res) => {
  const { name, clinicName, email, phone, message, url, scores, findings } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email required' });

  const lead = {
    id:         crypto.randomUUID(),
    createdAt:  new Date().toISOString(),
    status:     'new',       // new → contacted → contracted → lost
    name,
    clinicName: clinicName || '',
    email,
    phone:      phone || '',
    message:    message || '',
    url:        url || '',
    scores:     scores || null,
    findings:   findings || null,
    notes:      '',          // internal notes by marketing staff
  };

  const leads = readLeads();
  leads.unshift(lead);
  writeLeads(leads);

  res.json({ ok: true, id: lead.id });
});

/* GET /api/leads — list all leads (for dashboard) */
app.get('/api/leads', (req, res) => {
  const leads = readLeads();
  // Return summary list (without heavy findings data)
  const summary = leads.map(l => ({
    id: l.id, createdAt: l.createdAt, status: l.status,
    name: l.name, clinicName: l.clinicName, email: l.email,
    phone: l.phone, url: l.url,
    scores: l.scores || null,
    totalScore: l.scores ? Math.round((l.scores.uiux + l.scores.usability + l.scores.ia + l.scores.cta + l.scores.mobile) / 5) : null,
  }));
  res.json(summary);
});

/* GET /api/leads/:id — full lead detail */
app.get('/api/leads/:id', (req, res) => {
  const leads = readLeads();
  const lead  = leads.find(l => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  res.json(lead);
});

/* PATCH /api/leads/:id — update status / notes */
app.patch('/api/leads/:id', (req, res) => {
  const leads = readLeads();
  const idx   = leads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });

  const { status, notes } = req.body;
  if (status) leads[idx].status = status;
  if (notes !== undefined) leads[idx].notes = notes;
  writeLeads(leads);

  res.json({ ok: true });
});

/* DELETE /api/leads/:id */
app.delete('/api/leads/:id', (req, res) => {
  let leads = readLeads();
  leads = leads.filter(l => l.id !== req.params.id);
  writeLeads(leads);
  res.json({ ok: true });
});

/* POST /api/analyze-only — run analysis without saving lead (for dashboard re-analyze) */
app.post('/api/analyze-only', async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!url.startsWith('http')) url = 'https://' + url;

  try {
    const { html, fetchTime, finalUrl } = await fetchHTML(url);
    const $ = cheerio.load(html);
    const [cssResult, meta, schema, headings, images, responsive, cta, perf] = await Promise.all([
      fetchCSSFiles($, finalUrl || url),
      Promise.resolve(analyzeMeta($)),
      Promise.resolve(analyzeSchema(html)),
      Promise.resolve(analyzeHeadings($)),
      Promise.resolve(analyzeImages($)),
      Promise.resolve(analyzeResponsive($, html)),
      Promise.resolve(analyzeCTA($, html)),
      Promise.resolve(analyzePerformance(html, fetchTime)),
    ]);
    const css    = analyzeCSS($, cssResult.combined);
    const scores = calculateScores({ meta, schema, headings, images, responsive, css, cta, perf });

    res.json({
      ok: true, url: finalUrl || url, fetchTime, scores,
      findings: { meta, schema, headings, images, responsive, css, cta, perf, cssFiles: cssResult.files },
    });
  } catch (err) {
    res.status(200).json({ ok: false, url, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  Mediclick Analyzer → http://localhost:${PORT}\n`);
  console.log(`  Dashboard         → http://localhost:${PORT}/dashboard.html\n`);
});
