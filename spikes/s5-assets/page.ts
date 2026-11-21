/**
 * Generates the S5 test page: a storefront-style layout (banner, header, sidebar, card grid,
 * footer) whose size is set by the number of sections. Deterministic for a given seed.
 *
 * Rules the spike's independent checks rely on:
 *  - all text sits in leaf elements; every fixed-height text element is `white-space: nowrap`,
 *    so "content height / line-height" is a valid line count for the rest;
 *  - the banner is exactly 48px tall and the sidebar exactly 240px wide.
 */

export interface PageOptions {
  sections: number
  cardsPerSection?: number
  seed?: number
  /** URL of the script that carries the snapshot function, injected the way the proxy would. */
  script: string
}

const WORDS = (
  'aurora basalt cedar delta ember fjord granite harbor indigo juniper kestrel lumen meadow nimbus ' +
  'orchard prairie quartz ridge summit tundra umber valley willow zephyr compact wireless ergonomic ' +
  'premium lightweight modular portable rechargeable waterproof adjustable handcrafted limited'
).split(' ')
const TAGS = ['new', 'sale', 'eco', 'pro', 'mini', 'bundle', 'gift', 'top rated', 'refurb']
const NAV = ['Home', 'Catalog', 'Collections', 'Deals', 'Stories', 'Support', 'Stores', 'About']

const CSS = `
*{box-sizing:border-box}
html{font:14px/20px system-ui,-apple-system,"Segoe UI",sans-serif;color:#1c1c1e}
body{margin:0;background:#f5f5f7}
a{color:inherit;text-decoration:none}
h1,h2,h3,h4,p,ul{margin:0;padding:0;font-weight:600}
p{font-weight:400}
ul{list-style:none}
.banner{height:48px;display:flex;align-items:center;justify-content:center;gap:12px;background:#1d4ed8;color:#fff;padding:0 16px}
.banner-cta{padding:2px 10px;border:1px solid #fff;border-radius:12px;white-space:nowrap}
.banner-close{width:24px;height:24px;border:0;border-radius:12px;background:#1e40af;color:#fff;font:inherit;white-space:nowrap}
.header{position:relative;height:64px;display:flex;align-items:center;gap:24px;padding:0 24px;background:#fff;border-bottom:1px solid #e5e5ea}
.logo{font-weight:700;font-size:18px;line-height:24px;white-space:nowrap}
.nav{display:flex;gap:16px;flex:1}
.nav-link{padding:6px 8px;border-radius:6px;white-space:nowrap}
.header-actions{display:flex;align-items:center;gap:12px}
.search{width:220px;height:32px;border:1px solid #d1d1d6;border-radius:8px;padding:0 10px;font:inherit}
.cart{height:32px;padding:0 12px;border:1px solid #d1d1d6;border-radius:8px;background:#fff;font:inherit;white-space:nowrap}
.avatar{width:32px;height:32px;border-radius:50%;background:#c7c7cc}
.mobile-menu{display:none}
.dropdown{position:absolute;top:56px;left:160px;width:200px;padding:8px;background:#fff;border:1px solid #e5e5ea;visibility:hidden}
.dropdown-link{display:block;padding:4px 0}
.layout{display:flex;align-items:flex-start}
.sidebar{flex:0 0 240px;width:240px;padding:16px;background:#fff;border-right:1px solid #e5e5ea}
.side-group{margin-bottom:16px}
.side-title{font-size:12px;line-height:16px;text-transform:uppercase;color:#6e6e73;margin-bottom:6px}
.side-item{display:flex;justify-content:space-between;gap:8px;padding:4px 0}
.side-link{flex:1;min-width:0}
.count{color:#8e8e93;white-space:nowrap}
.side-promo{padding:12px;border-radius:8px;background:#eef2ff}
.promo-title{font-weight:600}
.promo-link{display:block;margin-top:4px;color:#1d4ed8}
.content{flex:1;min-width:0;padding:24px}
.crumbs{display:flex;gap:8px;color:#6e6e73;margin-bottom:8px}
.crumb{white-space:nowrap}
.page-title{font-size:28px;line-height:36px;margin-bottom:16px}
.toolbar{display:flex;gap:8px;margin-bottom:24px;overflow:hidden}
.chip{flex:0 0 104px;height:32px;line-height:30px;text-align:center;border:1px solid #d1d1d6;border-radius:16px;background:#fff;white-space:nowrap}
.section{margin-bottom:32px}
.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:12px}
.section-title{font-size:20px;line-height:28px}
.see-all{color:#1d4ed8;white-space:nowrap}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
.card{display:flex;flex-direction:column;padding:12px;background:#fff;border:1px solid #e5e5ea;border-radius:12px}
.card-media{position:relative;flex:0 0 120px;border-radius:8px;background:#e5e5ea;margin-bottom:12px}
.thumb{position:absolute;inset:0;border-radius:8px;background:linear-gradient(135deg,#c7d2fe,#fbcfe8)}
.badge{position:absolute;top:8px;left:8px;padding:2px 8px;border-radius:10px;background:#111;color:#fff;font-size:12px;line-height:16px;white-space:nowrap}
.card-body{display:flex;flex-direction:column;flex:1}
.card-title{font-size:16px;line-height:22px;margin-bottom:4px}
.card-desc{color:#6e6e73;margin-bottom:8px}
.card-meta{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.price{font-weight:600;white-space:nowrap}
.rating{display:flex;gap:2px}
.star{width:12px;height:12px;border-radius:2px;background:#f59e0b}
.tags{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:12px}
.tag{padding:2px 8px;border-radius:10px;background:#f2f2f7;font-size:12px;line-height:16px;white-space:nowrap}
.card-actions{display:flex;gap:8px;margin-top:auto}
.btn{flex:1;height:32px;border-radius:8px;border:1px solid #d1d1d6;background:#fff;font:inherit;white-space:nowrap}
.btn.primary{background:#111;color:#fff;border-color:#111}
.pagination{display:flex;gap:8px;justify-content:center}
.page-link{width:32px;height:32px;line-height:30px;text-align:center;border-radius:8px;background:#fff;border:1px solid #d1d1d6;white-space:nowrap}
.footer{padding:32px 24px;background:#1c1c1e;color:#d1d1d6}
.footer-cols{display:grid;grid-template-columns:repeat(4,1fr);gap:24px;margin-bottom:24px}
.footer-title{color:#fff;margin-bottom:8px}
.footer-link{display:block;padding:2px 0}
.legal{display:flex;justify-content:space-between;gap:16px;border-top:1px solid #3a3a3c;padding-top:16px}
.to-top{position:fixed;right:24px;bottom:24px;width:44px;height:44px;border-radius:22px;border:0;background:#111;color:#fff;font:inherit;white-space:nowrap}
[data-primp-root]{position:fixed;left:16px;bottom:16px;z-index:2147483647;width:320px;padding:8px;background:#fff;border:1px solid #111;border-radius:8px}
.fake-dock-row{display:flex;gap:4px;height:20px}
.fake-dock-cell{flex:1;background:#ddd}
`

export function buildPage(opts: PageOptions): string {
  const cards = opts.cardsPerSection ?? 12
  let state = (opts.seed ?? 20261120) >>> 0
  const rand = (n: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return Math.floor((state / 0x100000000) * n)
  }
  const words = (min: number, max: number): string => {
    const n = min + rand(max - min + 1)
    const out: string[] = []
    for (let i = 0; i < n; i++) out.push(WORDS[rand(WORDS.length)]!)
    const s = out.join(' ')
    return s.charAt(0).toUpperCase() + s.slice(1)
  }
  const h: string[] = []

  h.push(
    `<div id="promo-banner" class="banner"><span class="banner-text">Free shipping on orders over $50 this week</span>` +
      `<a class="banner-cta" href="#">Shop now</a><button class="banner-close">x</button></div>`,
  )

  h.push(`<header id="site-header" class="header"><a class="logo" href="#">Northwind</a><nav class="nav">`)
  for (const n of NAV) h.push(`<a class="nav-link" href="#">${n}</a>`)
  h.push(
    `</nav><div class="header-actions"><input class="search" placeholder="Search">` +
      `<button class="cart">Cart (3)</button><div class="avatar"></div></div>`,
  )
  h.push(`<div id="mobile-menu" class="mobile-menu">`)
  for (let i = 0; i < 40; i++) h.push(`<a class="mobile-link" href="#">Hidden ${i}</a>`)
  h.push(`</div><div id="dropdown" class="dropdown">`)
  for (let i = 0; i < 6; i++) h.push(`<a class="dropdown-link" href="#">Closed menu ${i}</a>`)
  h.push(`</div></header>`)

  h.push(`<div id="layout" class="layout"><aside id="sidebar" class="sidebar">`)
  for (let g = 0; g < 6; g++) {
    h.push(`<div class="side-group"><h4 class="side-title">${words(1, 2)}</h4><ul class="side-list">`)
    for (let i = 0; i < 8; i++) {
      h.push(
        `<li class="side-item"><a class="side-link" href="#">${words(1, 3)}</a><span class="count">${rand(400)}</span></li>`,
      )
    }
    h.push(`</ul></div>`)
  }
  h.push(
    `<div class="side-promo"><div class="promo-title">Members save more</div>` +
      `<p class="promo-text">${words(8, 12)}</p><a class="promo-link" href="#">Join now</a></div></aside>`,
  )

  h.push(`<main id="content" class="content"><div class="crumbs">`)
  for (const c of ['Home', '/', 'Catalog', '/', 'All products']) h.push(`<span class="crumb">${c}</span>`)
  h.push(`</div><h1 class="page-title">All products for the season ahead</h1><div id="toolbar" class="toolbar">`)
  for (let i = 0; i < 10; i++) h.push(`<span class="chip">Filter ${i + 1}</span>`)
  h.push(`</div>`)

  for (let s = 0; s < opts.sections; s++) {
    h.push(
      `<section id="sec-${s}" class="section"><div class="section-head"><h2 class="section-title">${words(2, 5)}</h2>` +
        `<a class="see-all" href="#">See all</a></div><div class="grid">`,
    )
    for (let c = 0; c < cards; c++) {
      h.push(
        `<article id="card-${s}-${c}" class="card"><div class="card-media"><div class="thumb"></div>` +
          `<span class="badge">${TAGS[rand(TAGS.length)]}</span></div><div class="card-body">` +
          `<h3 class="card-title">${words(2, 7)}</h3><p class="card-desc">${words(8, 22)}</p>` +
          `<div class="card-meta"><span class="price">$${10 + rand(490)}.${10 + rand(89)}</span><span class="rating">` +
          `<i class="star"></i><i class="star"></i><i class="star"></i><i class="star"></i><i class="star"></i></span></div>` +
          `<div class="tags"><span class="tag">${TAGS[rand(TAGS.length)]}</span><span class="tag">${TAGS[rand(TAGS.length)]}</span>` +
          `<span class="tag">${TAGS[rand(TAGS.length)]}</span></div>` +
          `<div class="card-actions"><button class="btn primary">Add to cart</button><button class="btn ghost">Save</button></div>` +
          `</div></article>`,
      )
    }
    h.push(`</div></section>`)
  }

  h.push(`<div class="pagination">`)
  for (let i = 1; i <= 7; i++) h.push(`<a class="page-link" href="#">${i}</a>`)
  h.push(`</div></main></div>`)

  h.push(`<footer id="site-footer" class="footer"><div class="footer-cols">`)
  for (let c = 0; c < 4; c++) {
    h.push(`<div class="footer-col"><h4 class="footer-title">${words(1, 2)}</h4>`)
    for (let i = 0; i < 6; i++) h.push(`<a class="footer-link" href="#">${words(1, 3)}</a>`)
    h.push(`</div>`)
  }
  h.push(
    `</div><div class="legal"><span class="legal-text">(c) 2026 Northwind Goods</span>` +
      `<span id="wc-host" class="theme-switch"></span></div></footer>`,
  )
  h.push(`<button id="to-top" class="to-top">Top</button>`)

  // Stand-in for the primp dock: light children and a shadow tree, both of which must be ignored.
  h.push(`<div data-primp-root id="fake-dock">`)
  for (let r = 0; r < 4; r++) {
    h.push(`<div class="fake-dock-row">`)
    for (let c = 0; c < 4; c++) h.push(`<div class="fake-dock-cell"></div>`)
    h.push(`</div>`)
  }
  h.push(`</div>`)

  const boot = `
    const dock = document.getElementById('fake-dock').attachShadow({ mode: 'open' });
    dock.innerHTML = '<slot></slot>' + '<div style="height:12px"><span>dock</span></div>'.repeat(20);
    const wc = document.getElementById('wc-host').attachShadow({ mode: 'open' });
    wc.innerHTML = '<span class="wc-inner" style="display:inline-block">Theme <b class="wc-value" style="display:inline-block">Light</b></span>';
  `

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>primp S5 fixture</title><script src="${opts.script}"></script><style>${CSS}</style></head><body>` +
    h.join('') +
    `<script>${boot}</script></body></html>`
  )
}
