'use strict';
/*
 * charts.js — hand-written canvas chart engine (no external libraries).
 *
 * Supported specs:
 *   {type:'line',   x:[], series:[{name, y:[], dash?}], logY?, zeroLine?}
 *   {type:'banded', x:[], bands:[{name, lo:[], hi:[]}], lines:[...]}
 *   {type:'bars',   categories:[], series:[{name, y:[]}], logY?, dense?}
 *   {type:'scatter',points:[[x,y]], labels?:[], diagonal?}
 *   {type:'heatmap',values:[[..]], vmin, vmax, rowLabels?, colLabels?}
 *
 * All charts are DPI aware, resize themselves through a ResizeObserver, and
 * share one hover tooltip with a crosshair.
 */
(function () {
  const PALETTE = ['#2BB3A3', '#F2A93B', '#5B8DEF', '#E5534B', '#9C7BE0', '#7FB3D5', '#8494A7'];
  const AXIS = '#2A3846';
  const GRID = 'rgba(34, 48, 64, 0.75)';
  const TEXT = '#8494A7';
  const TEXT_DIM = '#61707F';

  const tip = () => document.getElementById('chart-tip');

  function ramp(t) {
    const stops = [
      [0.0, [11, 16, 21]],
      [0.22, [16, 54, 60]],
      [0.46, [24, 116, 110]],
      [0.68, [43, 179, 163]],
      [0.84, [214, 158, 66]],
      [1.0, [242, 211, 160]],
    ];
    const v = Math.max(0, Math.min(1, t));
    for (let i = 1; i < stops.length; i += 1) {
      if (v <= stops[i][0]) {
        const [a, ca] = stops[i - 1];
        const [b, cb] = stops[i];
        const f = (v - a) / (b - a || 1);
        return [
          Math.round(ca[0] + (cb[0] - ca[0]) * f),
          Math.round(ca[1] + (cb[1] - ca[1]) * f),
          Math.round(ca[2] + (cb[2] - ca[2]) * f),
        ];
      }
    }
    return stops[stops.length - 1][1];
  }

  function niceTicks(min, max, target) {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { ticks: [0, 1], min: 0, max: 1, dec: 0 };
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const step0 = span / Math.max(2, target);
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step * 0.5; v += step) ticks.push(Number(v.toFixed(10)));
    const dec = Math.max(0, Math.min(6, -Math.floor(Math.log10(step)) + (step < 1 ? 0 : 0)));
    return { ticks, min: lo, max: hi, dec, step };
  }

  function fmtNum(v) {
    const a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
    if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
    if (a >= 1) return String(Number(v.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : 2)));
    if (a >= 0.01) return String(Number(v.toFixed(3)));
    if (a >= 1e-6) return v.toExponential(1).replace('e-', 'e−');
    return v.toExponential(1).replace('e-', 'e−');
  }

  function fmtLog(v) {
    if (!Number.isFinite(v) || v <= 0) return '0';
    const e = Math.log10(v);
    if (Math.abs(e) < 3) return String(Number(v.toPrecision(2)));
    return `10^${e.toFixed(0)}`;
  }

  function prep(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(60, canvas.clientWidth);
    const h = Math.max(40, canvas.clientHeight);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h, dpr };
  }

  function axes(ctx, box, yTicks, xLabel, yLabel, logY) {
    const { x0, x1, y0, y1 } = box;
    ctx.save();
    ctx.font = '10px -apple-system, "SF Mono", ui-monospace, monospace';
    ctx.fillStyle = TEXT_DIM;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    yTicks.forEach((t) => {
      const p = box.yOf(t);
      if (p < y0 - 1 || p > y1 + 1) return;
      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0, Math.round(p) + 0.5);
      ctx.lineTo(x1, Math.round(p) + 0.5);
      ctx.stroke();
      ctx.fillText(logY ? fmtLog(t) : fmtNum(t), x0 - 7, p);
    });
    // frame
    ctx.strokeStyle = AXIS;
    ctx.beginPath();
    ctx.moveTo(x0 + 0.5, y0);
    ctx.lineTo(x0 + 0.5, y1 + 0.5);
    ctx.lineTo(x1, y1 + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  function xLabels(ctx, box, labels, y) {
    ctx.save();
    ctx.font = '10px -apple-system, "SF Mono", ui-monospace, monospace';
    ctx.fillStyle = TEXT_DIM;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    labels.forEach((l) => {
      if (l.x < box.x0 - 2 || l.x > box.x1 + 2) return;
      ctx.fillText(l.text, l.x, y);
    });
    ctx.restore();
  }

  function makeBox(w, h, pad) {
    return {
      x0: pad.l,
      x1: w - pad.r,
      y0: pad.t,
      y1: h - pad.b,
      get wd() { return this.x1 - this.x0; },
      get ht() { return this.y1 - this.y0; },
    };
  }

  const logPos = (v, lo, hi) => (Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo) || 1);

  function hoverIndex(spec, ratio, count) {
    if (spec.type === 'bars') return Math.max(0, Math.min(count - 1, Math.floor(ratio * count)));
    if (spec.type === 'heatmap') return 0;
    const n = (spec.x || spec.points || []).length;
    return Math.max(0, Math.min(n - 1, Math.round(ratio * (n - 1))));
  }

  function drawSeries(ctx, box, spec, style) {
    const { x0, x1, y0, y1 } = box;
    const logY = !!spec.logY;
    const xs = spec.x || [];
    const n = xs.length;
    const px = (i) => x0 + (n <= 1 ? 0 : (i / (n - 1)) * (x1 - x0));
    const yMin = style.yMin;
    const yMax = style.yMax;
    const py = (v) => {
      const t = logY ? logPos(v, yMin, yMax) : (v - yMin) / (yMax - yMin || 1);
      return y1 - Math.max(0, Math.min(1, t)) * (y1 - y0);
    };
    (spec.bands || []).forEach((band, bi) => {
      ctx.beginPath();
      for (let i = 0; i < n; i += 1) {
        const y = py(band.hi[i]);
        if (i === 0) ctx.moveTo(px(i), y); else ctx.lineTo(px(i), y);
      }
      for (let i = n - 1; i >= 0; i -= 1) ctx.lineTo(px(i), py(band.lo[i]));
      ctx.closePath();
      ctx.fillStyle = bi === 0 ? 'rgba(43, 179, 163, 0.16)' : 'rgba(43, 179, 163, 0.26)';
      ctx.fill();
      ctx.strokeStyle = bi === 0 ? 'rgba(43,179,163,0.28)' : 'rgba(43,179,163,0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();
    });
    (spec.series || []).forEach((s, si) => {
      ctx.beginPath();
      for (let i = 0; i < n; i += 1) {
        const y = py(s.y[i]);
        if (i === 0) ctx.moveTo(px(i), y); else ctx.lineTo(px(i), y);
      }
      ctx.strokeStyle = s.color || PALETTE[si % PALETTE.length];
      ctx.lineWidth = 1.6;
      ctx.setLineDash(s.dash ? [4, 3] : []);
      ctx.stroke();
      ctx.setLineDash([]);
    });
    (spec.lines || []).forEach((s, si) => {
      ctx.beginPath();
      for (let i = 0; i < n; i += 1) {
        const y = py(s.y[i]);
        if (i === 0) ctx.moveTo(px(i), y); else ctx.lineTo(px(i), y);
      }
      ctx.strokeStyle = s.color || PALETTE[(si + 1) % PALETTE.length];
      ctx.lineWidth = 1.6;
      ctx.setLineDash(s.dash ? [4, 3] : []);
      ctx.stroke();
      ctx.setLineDash([]);
    });
    return { px, py, n };
  }

  function renderLine(canvas) {
    const spec = canvas._spec;
    const { ctx, w, h } = prep(canvas);
    const pad = { l: 46, r: 12, t: 10, b: 26 };
    const box = makeBox(w, h, pad);
    const logY = !!spec.logY;
    const seriesList = [...(spec.series || []), ...(spec.lines || [])];
    const all = [];
    for (const s of seriesList) for (const v of s.y) all.push(v);
    (spec.bands || []).forEach((b) => { for (const v of b.lo) all.push(v); for (const v of b.hi) all.push(v); });
    const useLog = logY && all.every((v) => v > 0);
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (!useLog && spec.zeroLine) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (useLog) {
      lo = Math.pow(10, Math.floor(Math.log10(lo)));
      hi = Math.pow(10, Math.ceil(Math.log10(hi)));
      if (lo === hi) hi = lo * 10;
    } else {
      const t = niceTicks(lo, hi, 4);
      lo = t.min; hi = t.max;
    }
    const yTicks = useLog
      ? (() => { const out = []; for (let e = Math.log10(lo); e <= Math.log10(hi) + 1e-9; e += 1) out.push(Math.pow(10, Math.round(e))); return out; })()
      : niceTicks(lo, hi, 4).ticks;
    box.yOf = (v) => {
      const t = useLog ? logPos(v, lo, hi) : (v - lo) / (hi - lo || 1);
      return box.y1 - Math.max(0, Math.min(1, t)) * (box.y1 - box.y0);
    };
    axes(ctx, box, yTicks, spec.xLabel, spec.yLabel, useLog);
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x0, box.y0 - 2, box.wd, box.ht + 4);
    ctx.clip();
    const geom = drawSeries(ctx, box, spec, { yMin: lo, yMax: hi });
    if (spec.zeroLine && !useLog && lo <= 0 && hi >= 0) {
      const zy = box.yOf(0);
      ctx.strokeStyle = 'rgba(132, 148, 167, 0.35)';
      ctx.beginPath();
      ctx.moveTo(box.x0, zy + 0.5);
      ctx.lineTo(box.x1, zy + 0.5);
      ctx.stroke();
    }
    ctx.restore();

    // x axis labels
    const xs = spec.x || [];
    const n = xs.length;
    const labels = [];
    const count = Math.min(6, n);
    for (let k = 0; k < count; k += 1) {
      const i = count === 1 ? 0 : Math.round((k / (count - 1)) * (n - 1));
      const v = xs[i];
      labels.push({ x: box.x0 + (i / Math.max(1, n - 1)) * box.wd, text: typeof v === 'number' ? fmtNum(v) : String(v) });
    }
    xLabels(ctx, box, labels, box.y1 + 7);

    canvas._geom = { box, px: geom.px, py: geom.py, n, yMin: lo, yMax: hi };
  }

  function renderBars(canvas) {
    const spec = canvas._spec;
    const { ctx, w, h } = prep(canvas);
    const pad = { l: 46, r: 12, t: 10, b: 26 };
    const box = makeBox(w, h, pad);
    const cats = spec.categories || [];
    const seriesList = spec.series || [];
    const all = [];
    for (const s of seriesList) for (const v of s.y) all.push(v);
    const useLog = spec.logY && all.every((v) => v > 0);
    let lo = 0;
    let hi = Math.max(...all);
    if (useLog) {
      lo = Math.pow(10, Math.floor(Math.log10(Math.min(...all))));
      hi = Math.pow(10, Math.ceil(Math.log10(Math.max(...all))));
    } else {
      hi = niceTicks(0, hi, 4).max;
    }
    const yTicks = useLog
      ? (() => { const out = []; for (let e = Math.log10(lo); e <= Math.log10(hi) + 1e-9; e += 1) out.push(Math.pow(10, Math.round(e))); return out; })()
      : niceTicks(lo, hi, 4).ticks;
    box.yOf = (v) => {
      const t = useLog ? logPos(v, lo, hi) : (v - lo) / (hi - lo || 1);
      return box.y1 - Math.max(0, Math.min(1, t)) * (box.y1 - box.y0);
    };
    axes(ctx, box, yTicks, spec.xLabel, spec.yLabel, useLog);
    const n = cats.length;
    const groupW = box.wd / Math.max(1, n);
    const barW = Math.max(1, (groupW * 0.72) / seriesList.length);
    for (let i = 0; i < n; i += 1) {
      const gx = box.x0 + i * groupW + groupW * 0.14;
      seriesList.forEach((s, si) => {
        const v = s.y[i];
        const top = box.yOf(v);
        const base = box.yOf(useLog ? lo : 0);
        ctx.fillStyle = s.color || PALETTE[si % PALETTE.length];
        ctx.globalAlpha = useLog ? 0.95 : 0.85;
        ctx.fillRect(gx + si * barW, top, Math.max(1, barW - 0.6), Math.max(1, base - top));
        ctx.globalAlpha = 1;
      });
    }
    const labels = [];
    const count = spec.dense ? 5 : Math.min(8, n);
    for (let k = 0; k < count; k += 1) {
      const i = count === 1 ? 0 : Math.round((k / (count - 1)) * (n - 1));
      labels.push({ x: box.x0 + i * groupW + groupW / 2, text: String(cats[i]) });
    }
    xLabels(ctx, box, labels, box.y1 + 7);
    canvas._geom = { box, groups: n, groupW, yMin: lo, yMax: hi, useLog };
  }

  function renderBanded(canvas) {
    renderLine(canvas);
  }

  function renderScatter(canvas) {
    const spec = canvas._spec;
    const { ctx, w, h } = prep(canvas);
    const pad = { l: 46, r: 14, t: 10, b: 26 };
    const box = makeBox(w, h, pad);
    const pts = spec.points || [];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    let xlo = Math.min(...xs);
    let xhi = Math.max(...xs);
    let ylo = Math.min(...ys);
    let yhi = Math.max(...ys);
    if (spec.diagonal) { const m = Math.max(xhi, yhi); xlo = 0; ylo = 0; xhi = m * 1.08; yhi = m * 1.08; }
    const tx = niceTicks(xlo, xhi, 4);
    const ty = niceTicks(ylo, yhi, 4);
    const X = (v) => box.x0 + ((v - tx.min) / (tx.max - tx.min || 1)) * box.wd;
    const Y = (v) => box.y1 - ((v - ty.min) / (ty.max - ty.min || 1)) * box.ht;
    box.yOf = Y;
    axes(ctx, box, ty.ticks, spec.xLabel, spec.yLabel, false);
    for (let k = 0; k < tx.ticks.length; k += 1) {
      const v = tx.ticks[k];
      if (v < tx.min || v > tx.max) continue;
      ctx.fillStyle = TEXT_DIM;
      ctx.font = '10px -apple-system, "SF Mono", ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(fmtNum(v), X(v), box.y1 + 7);
    }
    if (spec.diagonal) {
      const m = Math.max(tx.max, ty.max);
      ctx.strokeStyle = 'rgba(132,148,167,0.3)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(X(tx.min), Y(ty.min));
      ctx.lineTo(X(m), Y(m));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    pts.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(X(p[0]), Y(p[1]), 3.2, 0, Math.PI * 2);
      ctx.fillStyle = PALETTE[i % PALETTE.length];
      ctx.globalAlpha = 0.9;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(11,15,20,0.9)';
      ctx.lineWidth = 1;
      ctx.stroke();
      if (spec.labels && spec.labels[i]) {
        ctx.fillStyle = TEXT;
        ctx.font = '9.5px -apple-system, "SF Mono", ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(spec.labels[i], X(p[0]) + 6, Y(p[1]));
      }
    });
    canvas._geom = { box, pts, X, Y };
  }

  function renderHeatmap(canvas) {
    const spec = canvas._spec;
    const { ctx, w, h } = prep(canvas);
    const hasRowLabels = Array.isArray(spec.rowLabels) && spec.rowLabels.length;
    const hasColLabels = Array.isArray(spec.colLabels) && spec.colLabels.length;
    const pad = { l: hasRowLabels ? 54 : 46, r: 12, t: 10, b: hasColLabels ? 26 : 26 };
    const box = makeBox(w, h, pad);
    const values = spec.values || [];
    const rows = values.length;
    const cols = rows ? values[0].length : 0;
    if (!rows || !cols) return;
    const vmin = spec.vmin == null ? Math.min(...values.flat()) : spec.vmin;
    const vmax = spec.vmax == null ? Math.max(...values.flat()) : spec.vmax;
    const span = vmax - vmin || 1;
    // draw at cell resolution, then blit with smoothing off
    const off = document.createElement('canvas');
    off.width = cols;
    off.height = rows;
    const octx = off.getContext('2d');
    const img = octx.createImageData(cols, rows);
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const v = values[rows - 1 - y][x];
        const t = Math.max(0, Math.min(1, (v - vmin) / span));
        const c = ramp(t);
        const i = (y * cols + x) * 4;
        img.data[i] = c[0];
        img.data[i + 1] = c[1];
        img.data[i + 2] = c[2];
        img.data[i + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, box.x0, box.y0, box.wd, box.ht);
    ctx.strokeStyle = 'rgba(31,42,54,0.9)';
    ctx.strokeRect(box.x0 + 0.5, box.y0 + 0.5, box.wd - 1, box.ht - 1);
    // axes labels
    ctx.font = '10px -apple-system, "SF Mono", ui-monospace, monospace';
    ctx.fillStyle = TEXT_DIM;
    if (hasRowLabels) {
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const n = spec.rowLabels.length;
      spec.rowLabels.forEach((l, i) => {
        if (n > 12 && i % 2) return;
        ctx.fillText(l, box.x0 - 7, box.y0 + ((i + 0.5) / n) * box.ht);
      });
    } else {
      const t = niceTicks(vmin, vmax, 4);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      t.ticks.forEach((v) => {
        const p = box.y1 - ((v - t.min) / (t.max - t.min || 1)) * box.ht;
        if (p < box.y0 || p > box.y1) return;
        ctx.fillText(fmtNum(v), box.x0 - 7, p);
      });
    }
    if (hasColLabels) {
      const n = spec.colLabels.length;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      spec.colLabels.forEach((l, i) => {
        ctx.fillText(l, box.x0 + ((i + 0.5) / n) * box.wd, box.y1 + 7);
      });
    } else {
      const count = Math.min(6, cols);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const range = spec.xRange || null;
      for (let k = 0; k < count; k += 1) {
        const i = count === 1 ? 0 : Math.round((k / (count - 1)) * (cols - 1));
        let label = String(i);
        if (range) {
          const v = range[0] + ((range[1] - range[0]) * i) / Math.max(1, cols - 1);
          label = fmtNum(Number(v.toFixed(2)));
        }
        ctx.fillText(String(label), box.x0 + ((i + 0.5) / cols) * box.wd, box.y1 + 7);
      }
    }
    if (!hasRowLabels && spec.yRange) {
      // relabel the numeric y axis over the supplied range
      ctx.save();
      ctx.fillStyle = '#0B0F14';
      ctx.fillRect(0, box.y0 - 2, box.x0 - 2, box.ht + 4);
      ctx.restore();
      const count = 4;
      ctx.fillStyle = TEXT_DIM;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let k = 0; k < count; k += 1) {
        const v = spec.yRange[0] + ((spec.yRange[1] - spec.yRange[0]) * k) / (count - 1);
        ctx.fillText(fmtNum(Number(v.toFixed(2))), box.x0 - 7, box.y1 - (k / (count - 1)) * box.ht);
      }
    }
    canvas._geom = { box, rows, cols, vmin, vmax, values };
  }

  function render(canvas) {
    const spec = canvas._spec;
    if (!spec) return;
    if (spec.type === 'bars') renderBars(canvas);
    else if (spec.type === 'heatmap') renderHeatmap(canvas);
    else if (spec.type === 'scatter') renderScatter(canvas);
    else if (spec.type === 'banded') renderBanded(canvas);
    else renderLine(canvas);
    if (canvas._hover != null) drawHover(canvas);
  }

  function drawHover(canvas) {
    const spec = canvas._spec;
    const g = canvas._geom;
    if (!g) return;
    const idx = canvas._hover;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (spec.type === 'bars') {
      const x = g.box.x0 + idx * g.groupW;
      ctx.strokeStyle = 'rgba(230,237,243,0.28)';
      ctx.beginPath();
      ctx.moveTo(x + 0.5, g.box.y0);
      ctx.lineTo(x + 0.5, g.box.y1);
      ctx.stroke();
      return;
    }
    if (spec.type === 'heatmap') return;
    const p = g.px ? g.px(idx) : null;
    if (p == null) return;
    ctx.strokeStyle = 'rgba(230,237,243,0.3)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(p + 0.5, g.box.y0);
    ctx.lineTo(p + 0.5, g.box.y1);
    ctx.stroke();
    ctx.setLineDash([]);
    (spec.series || []).forEach((s, si) => {
      const y = g.py(s.y[idx]);
      ctx.beginPath();
      ctx.arc(p, y, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = s.color || PALETTE[si % PALETTE.length];
      ctx.fill();
    });
  }

  function showTip(canvas, evt) {
    const spec = canvas._spec;
    const g = canvas._geom;
    const el = tip();
    if (!spec || !g) return;
    const rect = canvas.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    const y = evt.clientY - rect.top;
    if (x < g.box.x0 || x > g.box.x1 || y < g.box.y0 || y > g.box.y1) { hideTip(canvas); return; }
    let html = '';
    if (spec.type === 'heatmap') {
      const cx = Math.floor(((x - g.box.x0) / g.box.wd) * g.cols);
      const cy = Math.floor(((y - g.box.y0) / g.box.ht) * g.rows);
      const v = g.values[g.rows - 1 - cy][cx];
      const col = spec.colLabels ? spec.colLabels[Math.min(g.cols - 1, cx)] : String(cx);
      const row = spec.rowLabels ? spec.rowLabels[Math.min(g.rows - 1, cy)] : String(g.rows - 1 - cy);
      html = `<div class="tip-x">${col} · ${row}</div><b>${fmtNum(v)}</b>${spec.unit ? ` ${spec.unit}` : ''}`;
    } else if (spec.type === 'scatter') {
      let best = null;
      let bd = 1e9;
      g.pts.forEach((p, i) => {
        const d = (g.X(p[0]) - x) ** 2 + (g.Y(p[1]) - y) ** 2;
        if (d < bd) { bd = d; best = i; }
      });
      if (best == null || bd > 900) { hideTip(canvas); return; }
      const p = g.pts[best];
      const label = spec.labels ? spec.labels[best] : `point ${best + 1}`;
      html = `<div class="tip-x">${label}</div>${spec.xLabel}: <b>${fmtNum(p[0])}</b><br>${spec.yLabel}: <b>${fmtNum(p[1])}</b>`;
    } else if (spec.type === 'bars') {
      const idx = Math.max(0, Math.min(g.groups - 1, Math.floor((x - g.box.x0) / g.groupW)));
      const cat = (spec.categories || [])[idx];
      html = `<div class="tip-x">${cat}</div>` + (spec.series || []).map((s, si) => (
        `<span style="color:${s.color || PALETTE[si % PALETTE.length]}">■</span> ${s.name}: <b>${fmtNum(s.y[idx])}</b>`
      )).join('<br>');
      canvas._hover = idx;
      render(canvas);
    } else {
      const n = g.n;
      const idx = Math.max(0, Math.min(n - 1, Math.round(((x - g.box.x0) / g.box.wd) * (n - 1))));
      const xv = spec.x ? spec.x[idx] : idx;
      const rows = (spec.series || []).map((s, si) => (
        `<span style="color:${s.color || PALETTE[si % PALETTE.length]}">■</span> ${s.name}: <b>${fmtNum(s.y[idx])}</b>`
      )).concat((spec.lines || []).map((s, si) => (
        `<span style="color:${s.color || PALETTE[(si + 1) % PALETTE.length]}">■</span> ${s.name}: <b>${fmtNum(s.y[idx])}</b>`
      )));
      html = `<div class="tip-x">${spec.xLabel || 'x'}: ${typeof xv === 'number' ? fmtNum(xv) : xv}</div>${rows.join('<br>')}`;
      canvas._hover = idx;
      render(canvas);
    }
    if (!el) return;
    el.innerHTML = html;
    el.hidden = false;
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    el.style.left = `${Math.min(window.innerWidth - tw - 12, evt.clientX + 14)}px`;
    el.style.top = `${Math.max(8, evt.clientY - th - 12)}px`;
  }

  function hideTip(canvas) {
    const el = tip();
    if (el) el.hidden = true;
    if (canvas) {
      const prev = canvas._hover;
      canvas._hover = null;
      if (prev != null) render(canvas);
    }
  }

  function mount(canvas, spec) {
    canvas._spec = spec;
    canvas._hover = null;
    if (!canvas._bound) {
      canvas._bound = true;
      canvas.addEventListener('mousemove', (e) => showTip(canvas, e));
      canvas.addEventListener('mouseleave', () => hideTip(canvas));
      if (window.ResizeObserver) {
        const ro = new ResizeObserver(() => render(canvas));
        ro.observe(canvas);
      }
    }
    render(canvas);
  }

  /** Tiny bar sparkline used for tile-utilisation rows and telemetry strips. */
  function sparkline(canvas, values, opts = {}) {
    const { ctx, w, h } = prep(canvas);
    const n = values.length;
    if (!n) return;
    const max = opts.max == null ? Math.max(...values, 0.0001) : opts.max;
    ctx.fillStyle = 'rgba(26,35,46,0.9)';
    ctx.fillRect(0, h - 2, w, 2);
    const slot = w / n;
    const bw = Math.max(1, slot - 1);
    for (let i = 0; i < n; i += 1) {
      const t = Math.max(0, Math.min(1, values[i] / max));
      const bh = Math.max(1, t * (h - 4));
      ctx.fillStyle = opts.color || `rgba(43,179,163,${0.18 + t * 0.62})`;
      ctx.fillRect(i * slot + 0.5, h - 2 - bh, bw, bh);
    }
  }

  /** Line sparkline for the live power / temperature strip. */
  function lineSpark(canvas, series, opts = {}) {
    const { ctx, w, h } = prep(canvas);
    if (!series[0] || series[0].values.length < 3) {
      ctx.strokeStyle = 'rgba(34,48,64,0.8)';
      ctx.beginPath();
      ctx.moveTo(0, h - 1.5);
      ctx.lineTo(w, h - 1.5);
      ctx.stroke();
      return;
    }
    const all = series.reduce((a, s) => a.concat(s.values.filter(Number.isFinite)), []);
    if (!all.length) return;
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (opts.min != null) lo = Math.min(lo, opts.min);
    if (opts.max != null) hi = Math.max(hi, opts.max);
    if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
    const pad = 2;
    series.forEach((s, si) => {
      ctx.beginPath();
      const n = s.values.length;
      for (let i = 0; i < n; i += 1) {
        const x = pad + (i / Math.max(1, n - 1)) * (w - pad * 2);
        const t = (s.values[i] - lo) / (hi - lo);
        const y = h - pad - t * (h - pad * 2);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = s.color || PALETTE[si % PALETTE.length];
      ctx.lineWidth = 1.4;
      ctx.stroke();
      if (s.fill && n > 8) {
        ctx.lineTo(w - pad, h - pad);
        ctx.lineTo(pad, h - pad);
        ctx.closePath();
        ctx.fillStyle = s.fill;
        ctx.fill();
      }
    });
  }

  window.Charts = { mount, render, sparkline, lineSpark, ramp, palette: PALETTE, fmtNum };
}());
