'use strict';
/* ui.js — DOM helpers, number formatting and micro-interactions. */
(function () {
  const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function el(sel) { return document.querySelector(sel); }
  function els(sel) { return Array.from(document.querySelectorAll(sel)); }

  function h(tag, attrs, html) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
      }
    }
    if (html != null) node.innerHTML = html;
    return node;
  }

  const si = (v, digits = 2) => {
    const a = Math.abs(v);
    if (a >= 1e12) return `${(v / 1e12).toFixed(digits)} T`;
    if (a >= 1e9) return `${(v / 1e9).toFixed(digits)} G`;
    if (a >= 1e6) return `${(v / 1e6).toFixed(digits)} M`;
    if (a >= 1e3) return `${(v / 1e3).toFixed(digits)} k`;
    return `${v.toFixed(digits)} `;
  };

  const fmt = {
    num(v, d = 2) { return Number.isFinite(v) ? v.toFixed(d) : '—'; },
    int(v) { return Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—'; },
    pct(v, d = 1) { return Number.isFinite(v) ? `${(v * 100).toFixed(d)} %` : '—'; },
    time(s) {
      if (!Number.isFinite(s)) return '—';
      if (s >= 3600) return `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')} m`;
      if (s >= 60) return `${Math.floor(s / 60)} m ${String(Math.round(s % 60)).padStart(2, '0')} s`;
      if (s >= 1) return `${s.toFixed(2)} s`;
      return `${(s * 1000).toFixed(0)} ms`;
    },
    energy(j) {
      if (!Number.isFinite(j)) return '—';
      if (j >= 1000) return `${(j / 1000).toFixed(2)} kJ`;
      if (j >= 1) return `${j.toFixed(2)} J`;
      return `${(j * 1000).toFixed(1)} mJ`;
    },
    power(w) { return Number.isFinite(w) ? `${w.toFixed(1)} W` : '—'; },
    flops(t) {
      if (!Number.isFinite(t)) return '—';
      if (t >= 1) return `${t.toFixed(2)} TFLOPS`;
      const f = t * 1e12;
      if (f >= 1e9) return `${(f / 1e9).toFixed(2)} GFLOPS`;
      if (f >= 1e6) return `${(f / 1e6).toFixed(1)} MFLOPS`;
      return `${(f / 1e3).toFixed(0)} kFLOPS`;
    },
    clock(iso) {
      if (!iso) return '—';
      const d = new Date(iso);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    },
    stamp(iso) {
      if (!iso) return '—';
      const d = new Date(iso);
      return `${d.toISOString().slice(0, 10)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    },
    kwh(j) { return `${(j / 3.6e6).toFixed(4)} kWh`; },
  };

  /** Animated number: counts from 0 to the target (skipped when reduced motion). */
  function tick(node, to, render, ms = 520) {
    const from = 0;
    if (reduced() || !Number.isFinite(to)) { node.textContent = render(to); return; }
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      node.textContent = render(from + (to - from) * eased);
      if (p < 1) requestAnimationFrame(step);
      else node.textContent = render(to);
    };
    requestAnimationFrame(step);
  }

  let toastTimer = null;
  function toast(message, kind = 'ok', ms = 3200) {
    const host = document.getElementById('toasts');
    if (!host) return;
    const node = h('div', { class: `toast ${kind}` }, esc(message));
    host.appendChild(node);
    setTimeout(() => { node.style.opacity = '0'; setTimeout(() => node.remove(), 220); }, ms);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { host.innerHTML = ''; }, ms + 400);
  }

  async function copy(text, label = 'Copied to clipboard') {
    try {
      await window.acpu.copy(text);
      toast(label);
    } catch (err) {
      toast('Could not copy to clipboard', 'err');
    }
  }

  /** Lightweight syntax colouring for a `name(k=v)` call. */
  function highlightCall(call) {
    const m = /^([A-Za-z_][\w]*)\((.*)\)$/.exec(call || '');
    if (!m) return esc(call || '');
    const args = m[2].split(',').map((s) => s.trim()).filter(Boolean).map((arg) => {
      const i = arg.indexOf('=');
      const k = arg.slice(0, i);
      const v = arg.slice(i + 1);
      const cls = /^".*"$/.test(v) ? 'str' : /^-?\d/.test(v) ? 'num' : 'key';
      return `<span class="key">${esc(k)}</span>=<span class="${cls}">${esc(v)}</span>`;
    });
    return `<span class="fn">${esc(m[1])}</span>(${args.join(', ')})`;
  }

  function keyboard(k, meta) {
    return meta ? `⌘${k}` : k;
  }

  function relTime(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60e3) return `${Math.max(1, Math.round(ms / 1000))} s ago`;
    if (ms < 3600e3) return `${Math.round(ms / 60e3)} min ago`;
    if (ms < 86400e3) return `${Math.round(ms / 3600e3)} h ago`;
    return `${Math.round(ms / 86400e3)} d ago`;
  }

  window.UI = { esc, el, els, h, fmt, tick, toast, copy, highlightCall, si, keyboard, relTime, reduced };
}());
