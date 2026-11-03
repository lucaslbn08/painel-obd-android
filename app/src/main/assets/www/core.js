/* Painel OBD – utilitários compartilhados: armazenamento, ajustes, avisos, diálogos, formulários,
   navegação entre telas e acesso aos recursos do Android (voz, vibração, compartilhar, brilho). */
(function () {
  const $ = id => document.getElementById(id);
  const BT = window.AndroidBT || null;
  const fmt = (v, d = 1) => (v == null || isNaN(v) ? '—' : Number(v).toFixed(d).replace('.', ','));
  const fmtInt = v => (v == null || isNaN(v) ? '—' : Math.round(v).toLocaleString('pt-BR'));
  const money = v => (v == null || isNaN(v) ? '—' : 'R$ ' + Number(v).toFixed(2).replace('.', ','));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const parseNum = s => {
    s = String(s == null ? '' : s).trim().replace(/\s/g, '');
    if (!s) return null;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');   // 123.456 = milhar
    const n = parseFloat(s); return isNaN(n) ? null : n;
  };
  const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const dateBR = iso => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—');
  const dur = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h} h ${String(m).padStart(2, '0')} min` : m ? `${m} min` : `${s} s`; };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
    json(k, def) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? def : v; } catch (_) { return def; } },
    put(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
  };

  /* ---------- ajustes ---------- */
  const DEFAULTS = {
    disp: 1.6, ve: 85, fuel: 'gasolina', ethanolPct: 27, consFactor: 1,
    autoConnect: true,
    alerts: { sound: true, voice: true, vib: true, temp: 105, battery: true, dtc: true, rpm: 0, speed: 0, maint: true },
    dash: { small: ['ect', 'fuel', 'load', 'thr'], tiles: ['bat', 'cons', 'iat', 'map', 'adv', 'tripavg', 'stft', 'ltft', 'o2', 'oil', 'tripkm', 'lph'] },
    hud: { main: 'speed', mirror: true }
  };
  function merge(d, s) {
    const o = Array.isArray(d) ? d.slice() : { ...d };
    if (!s || typeof s !== 'object') return o;
    for (const k in s) o[k] = d[k] && typeof d[k] === 'object' && !Array.isArray(d[k]) ? merge(d[k], s[k]) : s[k];
    return o;
  }
  const settings = merge(DEFAULTS, store.json('settings', {}));
  const saveSettings = () => store.put('settings', settings);

  /* ---------- eventos internos ---------- */
  const handlers = {};
  const on = (ev, fn) => (handlers[ev] = handlers[ev] || []).push(fn);
  const emit = (ev, ...a) => (handlers[ev] || []).forEach(fn => { try { fn(...a); } catch (e) { console.error(ev, e); } });

  /* ---------- aviso rápido ---------- */
  let toastT;
  function toast(msg, ms = 2800) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
  }
  const hideToast = () => $('toast').classList.remove('show');

  /* ---------- diálogo ---------- */
  let dlgDone = null;
  function dialog(title, text, buttons = [['OK', 'accent']], input) {
    if (dlgDone) dlgDone(-1);
    return new Promise(res => {
      $('dlg-title').textContent = title; $('dlg-text').textContent = text;
      const inp = $('dlg-input');
      inp.style.display = input ? 'block' : 'none';
      if (input) { inp.value = input.value || ''; inp.placeholder = input.placeholder || ''; setTimeout(() => inp.focus(), 100); }
      const a = $('dlg-actions'); a.innerHTML = '';
      dlgDone = i => { dlgDone = null; $('dlg-wrap').classList.remove('show'); res(input ? { i, value: inp.value } : i); };
      buttons.forEach(([label, kind], i) => {
        const b = document.createElement('button'); b.className = 'btn ' + (kind || ''); b.textContent = label;
        b.onclick = () => dlgDone && dlgDone(i);
        a.append(b);
      });
      $('dlg-wrap').classList.add('show');
    });
  }
  const closeDialog = () => { if (dlgDone) dlgDone(-1); };

  /* ---------- formulário em folha ----------
     fields: [{ key, label, type: number|text|date|select|toggle, value, options:[[v,label]], suffix, hint }] */
  let formDone = null;
  function form(title, fields, opts = {}) {
    if (formDone) formDone(null);
    return new Promise(res => {
      const box = $('form-body');
      box.innerHTML = `<div class="grip"></div><h2>${esc(title)}</h2>${opts.text ? `<p class="hint">${esc(opts.text)}</p>` : ''}`;
      const inputs = {};
      for (const f of fields) {
        const row = document.createElement('label');
        row.className = 'field' + (f.type === 'toggle' ? ' toggle' : '');
        let html = `<span>${esc(f.label)}</span>`;
        if (f.type === 'select') html += `<select>${f.options.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(f.value) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
        else if (f.type === 'toggle') html += `<input type="checkbox"${f.value ? ' checked' : ''}><i class="sw"></i>`;
        else html += `<div class="inp"><input type="${f.type === 'date' ? 'date' : 'text'}" ${f.type === 'number' ? 'inputmode="decimal"' : ''} value="${esc(f.value == null ? '' : (f.type === 'number' ? String(f.value).replace('.', ',') : f.value))}" placeholder="${esc(f.placeholder || '')}">${f.suffix ? `<em>${esc(f.suffix)}</em>` : ''}</div>`;
        if (f.hint) html += `<small>${esc(f.hint)}</small>`;
        row.innerHTML = html;
        box.append(row);
        inputs[f.key] = [f, row.querySelector('input,select')];
      }
      const actions = document.createElement('div'); actions.className = 'actions form-actions';
      const btns = [['Cancelar', '', null]].concat(opts.extra || []).concat([[opts.submit || 'Salvar', 'accent', 'ok']]);
      formDone = v => { formDone = null; $('form-wrap').classList.remove('show'); res(v); };
      for (const [label, kind, act] of btns) {
        const b = document.createElement('button'); b.className = 'btn ' + kind; b.textContent = label;
        b.onclick = () => {
          if (act === null) return formDone(null);
          const out = { _action: act };
          for (const k in inputs) {
            const [f, el] = inputs[k];
            out[k] = f.type === 'toggle' ? el.checked : f.type === 'number' ? parseNum(el.value) : el.value;
            if (act === 'ok' && f.required && (out[k] === null || out[k] === '')) { el.focus(); toast(`Preencha: ${f.label}`); return; }
          }
          formDone(out);
        };
        actions.append(b);
      }
      box.append(actions);
      $('form-wrap').classList.add('show');
    });
  }
  $('form-wrap').addEventListener('click', e => { if (e.target.id === 'form-wrap' && formDone) formDone(null); });

  /* ---------- navegação ---------- */
  const SUB = ['garage-pane', 'perf-pane', 'ready-pane', 'veh-pane', 'term-pane', 'custom-pane', 'settings-pane'];
  let pane = 'dash-pane';
  function show(id) {
    pane = id;
    const navId = SUB.includes(id) ? 'more-pane' : id;
    document.querySelectorAll('#nav button').forEach(x => x.classList.toggle('active', x.dataset.pane === navId));
    document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === id));
    const p = $(id); if (p) p.scrollTop = 0;
    emit('pane', id);
  }
  $('nav').addEventListener('click', e => { const b = e.target.closest('button'); if (b) show(b.dataset.pane); });
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-go]'); if (b) show(b.dataset.go);
  });
  // Botão "voltar" do Android: fecha janelas abertas, volta de sub-telas, depois vai para o Painel
  window.onAndroidBack = () => {
    if (emitBack()) return 1;
    if (formDone) { formDone(null); return 1; }
    if (dlgDone) { dlgDone(-1); return 1; }
    const ov = document.querySelector('.overlay.show'); if (ov) { ov.classList.remove('show'); return 1; }
    if (SUB.includes(pane)) { show('more-pane'); return 1; }
    if (pane !== 'dash-pane') { show('dash-pane'); return 1; }
    return 0;
  };
  const backHandlers = [];
  const onBack = fn => backHandlers.push(fn);
  const emitBack = () => backHandlers.some(fn => fn());

  /* ---------- Android: voz, vibração, compartilhar, brilho ---------- */
  const android = {
    has: m => !!(BT && typeof BT[m] === 'function'),
    speak(t) { if (android.has('speak')) BT.speak(t); },
    vibrate(p) { if (android.has('vibrate')) BT.vibrate(p.join(',')); else if (navigator.vibrate) navigator.vibrate(p); },
    brightness(on) { if (android.has('setBrightness')) BT.setBrightness(!!on); },
    shareImage(dataUrl, name) {
      if (android.has('shareImage')) return BT.shareImage(dataUrl.split(',')[1], name);
      const a = document.createElement('a'); a.href = dataUrl; a.download = name; a.click(); return name;
    },
    version() { return android.has('appVersion') ? BT.appVersion() : 'web'; }
  };
  let actx = null;
  document.addEventListener('click', () => { if (!actx) try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {} }, { capture: true });
  function beep(level = 'warn') {
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const seq = level === 'danger' ? [988, 0, 988, 0, 988] : [880, 0, 660];
      seq.forEach((f, i) => {
        if (!f) return;
        const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + i * 0.16;
        o.type = 'square'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
        o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + 0.15);
      });
    } catch (_) {}
  }

  /* ---------- arquivos: salvar na pasta Downloads/Painel OBD e compartilhar ---------- */
  const Files = {
    save(name, text, mime) {
      return new Promise(res => {
        if (android.has('saveFile2')) res(BT.saveFile2(name, (mime === 'text/csv' ? '\ufeff' : '') + text, mime));
        else { download(name, text, mime); res('Downloads/' + name); }
      });
    },
    share(name, text, mime) {
      if (android.has('shareText')) return BT.shareText(name, (mime === 'text/csv' ? '\ufeff' : '') + text, mime);
      download(name, text, mime); return name;
    }
  };
  function download(name, text, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime })); a.download = name; a.click();
  }
  window.Files = Files;

  window.U = { $, BT, fmt, fmtInt, money, esc, parseNum, today, dateBR, dur, store, settings, saveSettings, DEFAULTS,
    on, emit, toast, hideToast, dialog, closeDialog, form, show, onBack, get pane() { return pane; }, android, beep };
})();
