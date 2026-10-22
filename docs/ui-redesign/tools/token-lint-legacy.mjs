#!/usr/bin/env node
// 静态设计令牌闸门（无第三方依赖，Node 18+）
// 用法（仓库根目录）： node scripts/token-lint.mjs [--json]
// 退出码：0=全部通过；1=存在不合格规则。用于改版后复验与 CI 门禁。
import { readFileSync } from 'node:fs';

const WEB = 'src/public/styles.css';
const NATIVE = 'scripts/native/WidgetClient.cs';

// ---------- 阈值（本文件的验收基线，见 UI-ACCEPTANCE-BASELINE.md 第 4 节） ----------
const T = {
  textContrast: 4.5,      // WCAG 2.1 SC 1.4.3（正常文本）
  nonTextContrast: 3.0,   // WCAG 2.1 SC 1.4.11（交互控件边界/状态指示）
  maxColorTokens: 16,
  maxFontSizes: 8,
  minFontPx: 12,          // Web 正文下限
  minNativeDip: 11,       // WPF 字号下限（DIP）
  maxLineHeightRatios: 3,
  gridPx: 4,
  gridAllowlist: [2],     // 仅允许 2px 用于 hairline 补偿
  maxRadii: 3,
};

const css = readFileSync(WEB, 'utf8');
const cs = readFileSync(NATIVE, 'utf8');

const rules = (sel) => [...css.matchAll(new RegExp(sel.source, 'g'))];
const results = [];
const check = (id, title, ok, detail) => results.push({ id, title, ok, detail });

// ---------- 颜色 ----------
const root = /:root\{([^}]*)\}/.exec(css);
if (!root) throw new Error('未找到 :root 令牌块');
const tokens = {};
for (const m of root[1].matchAll(/(--[a-z-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)) tokens[m[1]] = m[2].toLowerCase();
const allHex = new Set([...css.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toLowerCase()));

const lum = (hex) => {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
};

const TEXT_ROLES = ['--text', '--muted', '--accent', '--warn', '--danger'];
const SURFACES = ['--bg', '--panel'];
const textFails = [];
for (const fg of TEXT_ROLES) {
  for (const bg of SURFACES) {
    if (!tokens[fg] || !tokens[bg]) continue;
    const r = ratio(tokens[fg], tokens[bg]);
    if (r < T.textContrast) textFails.push(`${fg} ${tokens[fg]} on ${bg} ${tokens[bg]} = ${r}:1`);
  }
}
check('R1', `文本对比度 ≥ ${T.textContrast}:1`, textFails.length === 0, textFails);

const nt = ratio(tokens['--line'], tokens['--panel']);
check('R2', `非文本对比度 ≥ ${T.nonTextContrast}:1（--line 对 --panel，控件边界）`, nt >= T.nonTextContrast,
  [`--line ${tokens['--line']} on --panel ${tokens['--panel']} = ${nt}:1`,
   `--line on --bg = ${ratio(tokens['--line'], tokens['--bg'])}:1`]);

check('R3', `Web 颜色令牌 ≤ ${T.maxColorTokens}`, allHex.size <= T.maxColorTokens, [`实测 ${allHex.size} 个 hex`]);
const nativeHex = new Set([...cs.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toLowerCase()));
check('R12', `原生颜色常量 ≤ ${T.maxColorTokens}`, nativeHex.size <= T.maxColorTokens, [`实测 ${nativeHex.size} 个 hex`]);

// ---------- 字号 / 行高（Web） ----------
const sizes = new Map(); // size -> Set(ratio)
for (const m of css.matchAll(/font(?:-size)?\s*:\s*(?:(?:\d{3}\s+)?)(\d+(?:\.\d+)?)px(?:\s*\/\s*(\d+(?:\.\d+)?|normal))?/g)) {
  const size = parseFloat(m[1]);
  const r = m[2];
  if (!sizes.has(size)) sizes.set(size, new Set());
  if (r && r !== 'normal') sizes.get(size).add(parseFloat(r));
}
const uniqSizes = [...sizes.keys()].sort((a, b) => a - b);
check('R4', `Web 字号阶 ≤ ${T.maxFontSizes}`, uniqSizes.length <= T.maxFontSizes,
  [`实测 ${uniqSizes.length} 阶: ${uniqSizes.join(', ')}px`]);
const tooSmall = uniqSizes.filter((s) => s < T.minFontPx);
check('R5', `Web 最小字号 ≥ ${T.minFontPx}px`, tooSmall.length === 0, [`低于下限: ${tooSmall.join(', ') || '无'}px`]);

const ratios = [...new Set([...sizes.values()].flatMap((s) => [...s]))].sort((a, b) => a - b);
check('R6', `行高比种类 ≤ ${T.maxLineHeightRatios}`, ratios.length <= T.maxLineHeightRatios, [`实测 ${ratios.length} 种: ${ratios.join(', ')}`]);
const dupSize = [...sizes.entries()].filter(([, s]) => s.size > 1).map(([k, s]) => `${k}px 映射多个行高比 (${[...s].join('/')})`);
check('R7', '同一字号只绑定一个行高比', dupSize.length === 0, dupSize);

// ---------- 间距 / 圆角（Web） ----------
const spacingVals = new Set();
for (const m of css.matchAll(/(?:padding|margin|gap|row-gap|column-gap)\s*:\s*([^;{}]+)/g)) {
  for (const tok of m[1].split(/\s+/)) {
    const v = /^(-?\d+(?:\.\d+)?)px$/.exec(tok);
    if (v && parseFloat(v[1]) !== 0) spacingVals.add(parseFloat(v[1]));
  }
}
const badSpacing = [...spacingVals].filter((v) => v % T.gridPx !== 0 && !T.gridAllowlist.includes(v));
check('R8', `Web 间距全部落在 ${T.gridPx}px 栅格（白名单 ${T.gridAllowlist.join('/')}px）`, badSpacing.length === 0,
  [`离栅格值: ${badSpacing.sort((a, b) => a - b).join(', ') || '无'}px`, `全部取值: ${[...spacingVals].sort((a, b) => a - b).join(', ')}px`]);

const radii = new Set([...css.matchAll(/border-radius\s*:\s*([^;{}]+)/g)]
  .flatMap((m) => m[1].match(/\d+(?:\.\d+)?px/g) || []));
check('R9', `圆角档位 ≤ ${T.maxRadii}`, radii.size <= T.maxRadii, [`实测 ${radii.size} 档: ${[...radii].join(', ')}`]);

// ---------- 原生（WPF） ----------
const nSizes = new Set();
for (const m of cs.matchAll(/(?:Text\((?:[^,()]|\([^()]*\))*?,\s*(\d+(?:\.\d+)?)\))|FontSize\s*=\s*(\d+(?:\.\d+)?)/g)) {
  nSizes.add(parseFloat(m[1] ?? m[2]));
}
const nSizesSorted = [...nSizes].sort((a, b) => a - b);
check('R10', `原生字号阶 ≤ ${T.maxFontSizes}`, nSizesSorted.length <= T.maxFontSizes,
  [`实测 ${nSizesSorted.length} 阶: ${nSizesSorted.join(', ')}`]);
const nTooSmall = nSizesSorted.filter((s) => s < T.minNativeDip);
check('R11', `原生最小字号 ≥ ${T.minNativeDip} DIP`, nTooSmall.length === 0, [`低于下限: ${nTooSmall.join(', ') || '无'}`]);

const thick = new Set();
for (const m of cs.matchAll(/new Thickness\(([^)]*)\)/g)) {
  for (const t of m[1].split(',')) {
    const v = t.trim();
    if (/^\d+(\.\d+)?$/.test(v) && parseFloat(v) > 0) thick.add(parseFloat(v));
  }
}
const badThick = [...thick].filter((v) => v % T.gridPx !== 0 && !T.gridAllowlist.includes(v));
check('R13', `原生 Thickness 全部落在 ${T.gridPx}px 栅格（白名单 ${T.gridAllowlist.join('/')}px）`, badThick.length === 0,
  [`离栅格值: ${badThick.sort((a, b) => a - b).join(', ') || '无'}`, `全部取值: ${[...thick].sort((a, b) => a - b).join(', ')}`]);

// ---------- 输出 ----------
const failed = results.filter((r) => !r.ok);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ thresholds: T, results, failed: failed.length }, null, 2));
} else {
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  ${r.title}`);
    for (const d of r.detail) console.log(`        · ${d}`);
  }
  console.log(`\n${failed.length} 项不合格 / 共 ${results.length} 项检查`);
}
process.exit(failed.length === 0 ? 0 : 1);
