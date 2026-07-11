// content/marketplace.js — runs on the India marketplaces we search to decide
// whether a product is sellable in India (Amazon.in / Flipkart / Nykaa / Meesho
// / JioMart). It does NOT decide anything: it returns candidate product-title
// strings from a search-results page; the service worker scores them against the
// query (config.titleSimilarity) and ticks the Origin "IN" chip when confident.
//
// Selectors are deliberately GENERIC (repeated result cards, headings, product
// links) so one scraper works across very different sites. It errs toward
// returning extra titles — noise scores low and is harmless; the risk is a
// truncated title missing a match, which a dry-run will surface.

(function () {
  if (window.__davMarketplaceReady) return;
  window.__davMarketplaceReady = true;

  const clip = (s, n) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim().slice(0, n || 100000);
  const NAV = /^(home|login|sign in|cart|account|help|offers|sell|download|categories?|menu|search|filter|sort|all|more|see all|wishlist|bag)$/i;

  // Collect candidate product titles from a search-results page.
  function scrapeTitles() {
    const out = new Set();
    const push = (t) => {
      t = clip(t, 200);
      if (t.length < 8 || t.length > 200) return;
      if (NAV.test(t)) return;
      if (t.split(' ').length < 2) return;          // product names are multi-word
      out.add(t);
    };

    // 1) Site-specific hints (best signal when present) + 2) generic fallbacks.
    const SEL = [
      // Amazon.in
      '[data-component-type="s-search-result"] h2', '.s-title-instructions-style h2', 'h2 a span',
      // Flipkart
      'a[class*="wjcEIp"]', 'div[class*="KzDlHZ"]', '._4rR01T', '.s1Q9rs', 'a.IRpwTa',
      // Nykaa
      '.css-xrzmfa', '[class*="productWrapper"] [class*="title" i]', '.product-title',
      // Meesho
      'p[class*="Text__StyledText"]', '[class*="ProductList"] p', '[class*="NewProductCard"] p',
      // JioMart
      '.plp-card-details-name', '[class*="plp-card"] [class*="name" i]',
      // Generic
      '[class*="product" i] [class*="title" i]', '[class*="product" i] [class*="name" i]',
      'article h2', 'article h3', 'li h2', 'li h3',
    ];
    for (const sel of SEL) {
      let nodes; try { nodes = document.querySelectorAll(sel); } catch { continue; }
      nodes.forEach(n => push(n.textContent));
      if (out.size >= 40) break;
    }

    // Generic fallback: anchors that look like product links (long-ish text).
    if (out.size < 8) {
      document.querySelectorAll('a[href]').forEach(a => {
        const t = a.textContent || '';
        if (t.length >= 12 && t.length <= 200) push(t);
      });
    }
    return Array.from(out).slice(0, 40);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const t = msg && msg.type;
    // Answer the managed-tab readiness ping so amazon-tab.navigate() works here.
    if (t === 'AMAZON_PING' || t === 'MP_PING') { sendResponse({ ok: true, ready: true }); return false; }
    if (t === 'MP_SEARCH_SCRAPE') {
      try { const titles = scrapeTitles(); sendResponse({ ok: true, titles, count: titles.length, url: location.href }); }
      catch (e) { sendResponse({ ok: false, error: e && e.message || String(e) }); }
      return false;
    }
    return false;
  });
})();
