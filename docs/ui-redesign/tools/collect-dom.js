// 浏览器端采集脚本（无依赖）：产出与 output/ui-audit/audit-S1.json 完全相同的 JSON schema。
// 用法 A（DevTools 控制台）：整段粘贴执行 → JSON.stringify(__uiAudit(), null, 0) 另存为 audit-S1.json
// 用法 B（Playwright / chrome-devtools MCP）：evaluate_script 传入本文件内容，返回值直接落盘
// 复验前置：npm run dev 已启动，页面在 http://127.0.0.1:4173
(() => {
  const MAX_BOXES = 4000;
  const sel = (el) => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 6; e = e.parentElement) {
      let s = e.tagName.toLowerCase();
      if (e.id) s += '#' + e.id;
      else if (e.classList.length) s += '.' + e.classList[0];
      parts.unshift(s);
    }
    return parts.join('>');
  };
  const parseColor = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s || '');
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => [r, g, b]
    .map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
    .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
  const blend = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
  };
  const effectiveBg = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const c = parseColor(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0) return c.a < 1 ? blend(c, { r: 255, g: 255, b: 255, a: 1 }) : c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };

  const boxes = [];
  const textNodes = [];
  const all = [document.documentElement, ...document.querySelectorAll('body *')].slice(0, MAX_BOXES);
  for (const el of all) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const first = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
    boxes.push({
      sel: sel(el),
      tag: el.tagName.toLowerCase(),
      fontSize: parseFloat(cs.fontSize),
      lineHeight: cs.lineHeight,
      fontFamily: (cs.fontFamily || '').split(',')[0].replace(/["']/g, '').trim(),
      color: cs.color,
      bg: cs.backgroundColor,
      pad: cs.padding,
      mar: cs.margin,
      gap: cs.gap,
      radius: cs.borderRadius,
      border: `${cs.borderTopWidth} ${cs.borderTopColor}`,
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    });
    if (!first) continue;
    const fgRaw = parseColor(cs.color);
    const bg = effectiveBg(el);
    const fg = fgRaw.a < 1 ? blend(fgRaw, bg) : fgRaw;
    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const cr = ratio(fg, bg);
    textNodes.push({
      sel: sel(el),
      text: first.textContent.trim().slice(0, 40),
      color: cs.color,
      bg: `rgb(${[bg.r, bg.g, bg.b].map((v) => Math.round(v)).join(', ')})`,
      ratio: cr,
      fontSize: size,
      fontWeight: weight,
      large,
      passes: cr >= (large ? 3 : 4.5),
    });
  }
  return {
    url: location.href,
    vp: {
      w: innerWidth,
      h: innerHeight,
      dpr: devicePixelRatio,
      docW: document.documentElement.scrollWidth,
      docH: document.documentElement.scrollHeight,
    },
    textCount: textNodes.length,
    textNodes,
    boxes,
  };
})();
