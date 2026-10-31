/* Mostradores analógicos (canvas) e gráfico de linha. */
(function () {
  const C = { text: '#e8eef4', muted: '#7f8d9b', dim: '#3b4855', track: '#1a2430', accent: '#1fd4ff',
    warn: '#ffb23e', danger: '#ff4f4f', dangerDark: '#4a1a1d', needle: '#ff3b30', panel: '#10161e', border: '#1f2b38' };
  const DPR = () => Math.min(window.devicePixelRatio || 1, 3);
  const all = [];

  class Gauge {
    constructor(el, o) {
      this.o = Object.assign({ minor: 5, labelDiv: 1, decimals: 0, compact: false }, o);
      this.el = el;
      this.bg = document.createElement('canvas');
      this.fg = document.createElement('canvas');
      el.append(this.bg, this.fg);
      this.value = null; this.shown = this.o.min; this.dirty = true;
      new ResizeObserver(() => this.layout()).observe(el);
      all.push(this);
    }
    fr(v) { const { min, max } = this.o; return Math.max(0, Math.min(1, (v - min) / (max - min))); }
    ang(f) { return (135 + 270 * f) * Math.PI / 180; } // canvas: 0 rad = direita, sentido horário
    xy(f, r) { const a = this.ang(f); return [this.cx + r * Math.cos(a), this.cy + r * Math.sin(a)]; }
    isRed(v) { const o = this.o; return (o.redFrom != null && v >= o.redFrom) || (o.lowRed != null && v <= o.lowRed); }

    layout() {
      const w = this.el.clientWidth, h = this.el.clientHeight;
      if (w < 40 || h < 40) return;
      const d = DPR();
      for (const c of [this.bg, this.fg]) { c.width = Math.round(w * d); c.height = Math.round(h * d); }
      this.w = w; this.h = h; this.cx = w / 2; this.cy = h / 2; this.r = Math.min(w, h) / 2 * 0.97;
      this.drawStatic(); this.dirty = true; this.drawDynamic();
    }

    drawStatic() {
      const g = this.bg.getContext('2d'), d = DPR(), o = this.o, k = o.compact ? 1.35 : 1;
      const { cx, cy, r } = this;
      g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, this.w, this.h);
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fillStyle = '#22303e'; g.fill();
      const rb = r * 0.965, grad = g.createRadialGradient(cx, cy - r * 0.2, r * 0.1, cx, cy, rb);
      grad.addColorStop(0, '#1a2531'); grad.addColorStop(1, '#06090d');
      g.beginPath(); g.arc(cx, cy, rb, 0, Math.PI * 2); g.fillStyle = grad; g.fill();
      const rt = r * 0.82, tw = Math.max(3, r * 0.07);
      this.rt = rt; this.tw = tw;
      const arc = (f0, f1, col) => { g.beginPath(); g.arc(cx, cy, rt, this.ang(f0), this.ang(f1)); g.strokeStyle = col; g.lineWidth = tw; g.lineCap = 'butt'; g.stroke(); };
      arc(0, 1, C.track);
      if (o.redFrom != null) arc(this.fr(o.redFrom), 1, C.dangerDark);
      if (o.lowRed != null) arc(0, this.fr(o.lowRed), C.dangerDark);
      const nmaj = Math.round((o.max - o.min) / o.major);
      g.textAlign = 'center'; g.textBaseline = 'middle';
      for (let i = 0; i <= nmaj; i++) {
        const v = o.min + i * o.major, f = this.fr(v), red = this.isRed(v);
        const [x1, y1] = this.xy(f, r * 0.64), [x2, y2] = this.xy(f, r * 0.73);
        g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.strokeStyle = red ? C.danger : C.text;
        g.lineWidth = Math.max(1.5, r * 0.02); g.lineCap = 'round'; g.stroke();
        const [lx, ly] = this.xy(f, r * (o.compact ? 0.47 : 0.52));
        const lab = v / o.labelDiv;
        g.fillStyle = red ? C.danger : C.text;
        g.font = `700 ${Math.max(7, r * 0.105 * k)}px Roboto, sans-serif`;
        g.fillText(Number.isInteger(lab) ? lab : String(lab).replace('.', ','), lx, ly);
        if (i < nmaj) for (let j = 1; j < o.minor; j++) {
          const vv = v + o.major * j / o.minor, ff = this.fr(vv);
          const [a1, b1] = this.xy(ff, r * 0.68), [a2, b2] = this.xy(ff, r * 0.73);
          g.beginPath(); g.moveTo(a1, b1); g.lineTo(a2, b2); g.strokeStyle = this.isRed(vv) ? C.danger : C.dim;
          g.lineWidth = Math.max(1, r * 0.009); g.stroke();
        }
      }
      if (o.compact) {
        g.fillStyle = C.accent; g.font = `700 ${Math.max(7, r * 0.11)}px Roboto, sans-serif`;
        g.fillText(o.title, cx, cy + r * 0.80);
      } else {
        g.fillStyle = C.muted; g.font = `${Math.max(7, r * 0.07)}px Roboto, sans-serif`;
        g.fillText(o.unit, cx, cy + r * 0.53);
        g.fillStyle = C.accent; g.font = `700 ${Math.max(7, r * 0.068)}px Roboto, sans-serif`;
        g.fillText(o.title, cx, cy + r * 0.70);
      }
    }

    zoneColor(v) {
      const o = this.o;
      if (v == null) return C.accent;
      if (this.isRed(v)) return C.danger;
      if (o.warnFrom != null && v >= o.warnFrom) return C.warn;
      return C.accent;
    }

    drawDynamic() {
      if (!this.w) return;
      const g = this.fg.getContext('2d'), d = DPR(), o = this.o, k = o.compact ? 1.35 : 1;
      const { cx, cy, r } = this;
      g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, this.w, this.h);
      const f = this.fr(this.shown), col = this.zoneColor(this.value);
      if (f > 0.004) {
        g.save(); g.shadowColor = col; g.shadowBlur = r * 0.08;
        g.beginPath(); g.arc(cx, cy, this.rt, this.ang(0), this.ang(f)); g.strokeStyle = col; g.lineWidth = this.tw; g.stroke();
        g.restore();
      }
      g.textAlign = 'center'; g.textBaseline = 'middle';
      const vy = cy + r * (o.compact ? 0.54 : 0.36);
      g.font = `700 ${r * (o.compact ? 0.21 : 0.17)}px Roboto, sans-serif`;
      if (this.value == null) { g.fillStyle = C.dim; g.fillText('--', cx, vy); }
      else {
        g.fillStyle = col === C.accent ? C.text : col;
        const txt = this.value.toFixed(o.decimals).replace('.', ',') + (o.compact ? o.unit : '');
        g.fillText(txt, cx, vy);
      }
      // ponteiro
      const a = this.ang(f), ca = Math.cos(a), sa = Math.sin(a), pa = -sa, ps = ca;
      const poly = (len, tail, base) => {
        g.beginPath(); g.moveTo(cx + len * ca, cy + len * sa); g.lineTo(cx + base * pa, cy + base * ps);
        g.lineTo(cx - tail * ca, cy - tail * sa); g.lineTo(cx - base * pa, cy - base * ps); g.closePath();
      };
      g.save(); g.shadowColor = 'rgba(255,59,48,.6)'; g.shadowBlur = r * 0.06;
      poly(r * 0.77, r * 0.14, r * 0.03); g.fillStyle = C.needle; g.fill(); g.restore();
      g.beginPath(); g.arc(cx, cy, r * 0.085, 0, Math.PI * 2); g.fillStyle = '#26323f'; g.fill();
      g.lineWidth = Math.max(1, r * 0.01); g.strokeStyle = '#3a4858'; g.stroke();
      g.beginPath(); g.arc(cx, cy, r * 0.035, 0, Math.PI * 2); g.fillStyle = '#0b1016'; g.fill();
    }

    set(v) { if (v !== this.value) { this.value = v; this.dirty = true; } }

    step() {
      const o = this.o, tgt = this.value == null ? o.min : Math.max(o.min, Math.min(o.max, this.value));
      const d = tgt - this.shown;
      if (Math.abs(d) < (o.max - o.min) * 0.001) {
        if (this.dirty) { this.shown = tgt; this.drawDynamic(); this.dirty = false; }
        return;
      }
      this.shown += d * 0.2; this.drawDynamic();
    }
  }

  (function frame() { for (const g of all) if (g.el.offsetParent) g.step(); requestAnimationFrame(frame); })();

  class Chart {
    constructor(canvas) { this.c = canvas; this.data = null; this.title = ''; this.unit = '';
      new ResizeObserver(() => this.draw()).observe(canvas); }
    set(title, unit, data) { this.title = title; this.unit = unit; this.data = data; this.draw(); }
    draw() {
      const c = this.c, d = DPR(), w = c.clientWidth, h = c.clientHeight;
      if (w < 50) return;
      c.width = w * d; c.height = h * d;
      const g = c.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0);
      g.fillStyle = C.panel; g.beginPath(); if (g.roundRect) g.roundRect(0.5, 0.5, w - 1, h - 1, 12); else g.rect(0.5, 0.5, w - 1, h - 1); g.fill();
      g.strokeStyle = C.border; g.stroke();
      g.textBaseline = 'middle';
      if (!this.data || this.data.length < 2) {
        g.fillStyle = C.muted; g.font = '13px Roboto, sans-serif'; g.textAlign = 'center';
        g.fillText(this.title ? `${this.title}: aguardando dados…` : 'Toque num parâmetro para ver o gráfico', w / 2, h / 2);
        return;
      }
      const WIN = 120000, tnow = this.data[this.data.length - 1][0];
      const pts = this.data.filter(p => p[0] >= tnow - WIN), vals = pts.map(p => p[1]);
      let lo = Math.min(...vals), hi = Math.max(...vals);
      if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
      const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
      const L = 48, R = 12, T = 32, B = 22, gw = w - L - R, gh = h - T - B;
      const X = t => L + (t - (tnow - WIN)) / WIN * gw, Y = v => T + (1 - (v - lo) / (hi - lo)) * gh;
      g.font = '10px Roboto, sans-serif';
      for (let i = 0; i < 4; i++) {
        const y = T + gh * i / 3, v = hi - (hi - lo) * i / 3;
        g.strokeStyle = C.border; g.beginPath(); g.moveTo(L, y); g.lineTo(w - R, y); g.stroke();
        g.fillStyle = C.muted; g.textAlign = 'right'; g.fillText(v.toFixed(1).replace('.', ','), L - 6, y);
      }
      g.textAlign = 'center';
      [[0, '-2 min'], [0.5, '-1 min'], [1, 'agora']].forEach(([f, t]) => g.fillText(t, L + gw * f, h - 10));
      g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1]))));
      const last = pts[pts.length - 1];
      g.strokeStyle = C.accent; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
      g.lineTo(X(last[0]), T + gh); g.lineTo(X(pts[0][0]), T + gh); g.closePath();
      g.fillStyle = 'rgba(31,212,255,.12)'; g.fill();
      g.beginPath(); g.arc(X(last[0]), Y(last[1]), 4, 0, Math.PI * 2); g.fillStyle = C.accent; g.fill();
      g.textAlign = 'left'; g.fillStyle = C.text; g.font = '700 12px Roboto, sans-serif';
      g.fillText(this.title, 12, 16);
      g.textAlign = 'right'; g.fillStyle = C.accent; g.font = '700 13px Roboto, sans-serif';
      g.fillText(`${last[1].toFixed(2).replace('.', ',')} ${this.unit}`, w - 12, 16);
    }
  }

  window.Gauge = Gauge; window.Chart = Chart;
})();
