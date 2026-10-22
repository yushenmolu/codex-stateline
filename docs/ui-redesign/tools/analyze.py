import json, re, sys, colorsys
from collections import Counter, defaultdict

def load(p):
    with open(p, 'r', encoding='utf-8') as f:
        return json.load(f)

def rgb(s):
    m = re.match(r'rgba?\(([^)]+)\)', s or '')
    if not m: return None
    p = [float(x.strip()) for x in m.group(1).split(',')]
    return (p[0], p[1], p[2])

def hexs(c):
    return '#%02x%02x%02x' % tuple(int(round(x)) for x in c)

def hsl(c):
    h, l, s = colorsys.rgb_to_hls(c[0]/255, c[1]/255, c[2]/255)
    return round(h*360, 1), round(s*100, 1), round(l*100, 1)

def pxvals(s):
    if not s: return []
    out = []
    for tok in s.split():
        if tok.endswith('px'):
            try: out.append(float(tok[:-2]))
            except ValueError: pass
    return out

def analyze(path, label):
    d = load(path)
    tn = d['textNodes']; bx = d['boxes']
    res = {'label': label, 'viewport': d['vp'], 'textNodes': len(tn), 'boxes': len(bx)}

    # ---------- contrast ----------
    groups = defaultdict(lambda: {'count': 0, 'samples': [], 'sizes': set(), 'weights': set(), 'pass': True, 'ratio': None})
    for t in tn:
        key = (t['color'], t['bg'])
        g = groups[key]
        g['count'] += 1
        g['sizes'].add(t['fontSize']); g['weights'].add(t['fontWeight'])
        if t['ratio'] is not None:
            g['ratio'] = t['ratio'] if g['ratio'] is None else min(g['ratio'], t['ratio'])
        if not t['passes']: g['pass'] = False
        if len(g['samples']) < 3: g['samples'].append((t['sel'], t['text'], t['fontSize'], t['ratio']))
    pairs = []
    for (fg, bg), g in groups.items():
        fc, bc = rgb(fg), rgb(bg)
        pairs.append({'fg': hexs(fc) if fc else fg, 'bg': hexs(bc) if bc else bg,
                      'ratio': g['ratio'], 'count': g['count'],
                      'fontSizes': sorted(g['sizes']), 'weights': sorted(g['weights']),
                      'pass': g['pass'], 'samples': g['samples']})
    pairs.sort(key=lambda x: (x['ratio'] if x['ratio'] is not None else 99))
    res['contrast_pairs'] = pairs
    res['contrast_failing'] = [p for p in pairs if not p['pass']]
    res['contrast_min'] = min((p['ratio'] for p in pairs if p['ratio'] is not None), default=None)

    # ---------- typography ----------
    sizes = Counter(); lh = Counter(); fam = Counter()
    lh_ratio = defaultdict(list)
    for b in bx:
        sizes[b['fontSize']] += 1
        fam[b['fontFamily']] += 1
        lh[b['lineHeight']] += 1
        try:
            lhv = float(b['lineHeight'].replace('px', ''))
            lh_ratio[b['fontSize']].append(round(lhv / b['fontSize'], 3))
        except Exception:
            pass
    res['font_sizes'] = dict(sorted(sizes.items()))
    res['line_heights'] = dict(lh)
    res['font_families'] = dict(fam)
    res['lh_ratio_by_size'] = {str(k): sorted(set(v)) for k, v in sorted(lh_ratio.items())}
    res['small_text'] = sorted([s for s in sizes if s < 12])

    # ---------- spacing ----------
    pads = Counter(); mars = Counter(); gaps = Counter(); radii = Counter(); borders = Counter()
    for b in bx:
        for v in pxvals(b['pad']): pads[v] += 1
        for v in pxvals(b['mar']): mars[v] += 1
        for v in pxvals(b['gap']): gaps[v] += 1
        for v in pxvals(b['radius']): radii[v] += 1
        if b['border'] and b['border'] != '0px':
            borders[b['border']] += 1
    def grid_report(c, name):
        vals = sorted(c)
        off4 = [v for v in vals if v % 4 != 0]
        off2 = [v for v in vals if v % 2 != 0]
        return {'name': name, 'values': dict(sorted(c.items())), 'unique': len(vals),
                'off_4px_grid': off4, 'off_2px_grid': off2}
    res['spacing'] = {'padding': grid_report(pads, 'padding'), 'margin': grid_report(mars, 'margin'),
                      'gap': grid_report(gaps, 'gap'), 'radius': grid_report(radii, 'radius'),
                      'borders': dict(borders)}

    # ---------- colour inventory ----------
    text_colors = Counter(); bg_colors = Counter(); border_colors = Counter()
    for t in tn:
        c = rgb(t['color'])
        if c: text_colors[hexs(c)] += 1
    for b in bx:
        c = rgb(b['bg'])
        if c and not (c == (0, 0, 0)): bg_colors[hexs(c)] += 1
        if b['border']:
            parts = b['border'].split()
            if len(parts) > 1:
                c = rgb(parts[1])
                if c: border_colors[hexs(c)] += 1
    allc = set()
    allc.update(text_colors, bg_colors, border_colors)
    hslinfo = []
    for h in sorted(allc):
        c = rgb('rgb(%d,%d,%d)' % (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16)))
        hh, ss, ll = hsl(c)
        role = []
        if h in text_colors: role.append('text')
        if h in bg_colors: role.append('bg')
        if h in border_colors: role.append('border')
        hslinfo.append({'hex': h, 'hue': hh, 'sat': ss, 'light': ll, 'roles': role,
                        'uses': text_colors[h] + bg_colors[h] + border_colors[h]})
    res['colors'] = {'unique': len(allc), 'tokens': hslinfo,
                     'hue_buckets': dict(Counter(int(t['hue'] // 30) * 30 for t in hslinfo)),
                     'sat_bands': {'0-10': 0, '10-25': 0, '25-50': 0, '50+': 0}}
    for t in hslinfo:
        s = t['sat']
        k = '0-10' if s < 10 else '10-25' if s < 25 else '25-50' if s < 50 else '50+'
        res['colors']['sat_bands'][k] += 1

    # ---------- grid alignment ----------
    xs = Counter(); off = []
    for b in bx:
        x = b['rect'][0]
        r = x % 4
        xs[r] += 1
        if r != 0 and len(off) < 40:
            off.append({'sel': b['sel'], 'x': x, 'mod4': r})
    res['grid'] = {'x_mod4': dict(xs), 'off_grid_samples': off, 'off_grid_count': sum(v for k, v in xs.items() if k != 0)}
    widths = sorted({b['rect'][2] for b in bx})
    res['widths'] = widths

    # ---------- component drift ----------
    drift = defaultdict(lambda: defaultdict(set))
    for b in bx:
        tag = b['tag']
        drift[tag]['height'].add(b['rect'][3])
        drift[tag]['fontSize'].add(b['fontSize'])
        drift[tag]['radius'].add(b['radius'])
        drift[tag]['fontFamily'].add(b['fontFamily'])
        drift[tag]['lineHeight'].add(b['lineHeight'])
    drift_out = {}
    for tag, d2 in drift.items():
        if len(d2['fontSize']) > 1 or len(d2['radius']) > 1 or len(d2['lineHeight']) > 1:
            drift_out[tag] = {k: sorted(v) for k, v in d2.items()}
    res['drift'] = drift_out
    return res

out = {'S1': analyze('output/ui-audit/audit-S1.json', 'default(折叠)'),
       'S2': analyze('output/ui-audit/audit-S2.json', 'expanded(展开)')}

with open('output/ui-audit/analysis.json', 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=1, default=list)

for k, r in out.items():
    print('=' * 70)
    print(k, r['label'], 'vp', r['viewport'], 'text', r['textNodes'], 'boxes', r['boxes'])
    print('CONTRAST min =', r['contrast_min'], ' failing pairs =', len(r['contrast_failing']))
    for p in r['contrast_pairs'][:14]:
        print('  %s on %s ratio=%s n=%d sizes=%s w=%s pass=%s' % (p['fg'], p['bg'], p['ratio'], p['count'], p['fontSizes'], p['weights'], p['pass']))
    print('font sizes:', r['font_sizes'])
    print('lh by size:', r['lh_ratio_by_size'])
    print('line-heights(raw):', r['line_heights'])
    print('families:', r['font_families'])
    print('small<12:', r['small_text'])
    for kk in ('padding', 'margin', 'gap', 'radius'):
        s = r['spacing'][kk]
        print(kk, 'unique=%d' % s['unique'], s['values'], 'off4=', s['off_4px_grid'])
    print('borders:', r['spacing']['borders'])
    print('colors unique=', r['colors']['unique'], 'hue buckets', r['colors']['hue_buckets'], 'sat', r['colors']['sat_bands'])
    for t in r['colors']['tokens']:
        print('   ', t['hex'], 'H%5.1f S%5.1f L%5.1f' % (t['hue'], t['sat'], t['light']), t['roles'], 'n=%d' % t['uses'])
    print('grid x mod4:', r['grid']['x_mod4'], 'offgrid', r['grid']['off_grid_count'])
    print('drift tags:', list(r['drift'].keys()))
