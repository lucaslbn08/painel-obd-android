/* Painel OBD – lógica da tela. */
(function () {
  const $ = id => document.getElementById(id);
  const BT = window.AndroidBT || null;
  const fmt = (v, d = 1) => v.toFixed(d).replace('.', ',');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
  };

  const S = { engine: null, connected: false, demo: false, values: {}, raw: {}, minmax: {}, history: {},
    supported: [], readTimes: [], rec: null, chartPid: null, chartLast: 0, pane: 'dash-pane' };

  /* ---------- mostradores ---------- */
  const G = {
    rpm: new Gauge($('g-rpm'), { title: 'ROTAÇÃO', unit: 'rpm ×1000', min: 0, max: 8000, major: 1000, minor: 5, redFrom: 6500, labelDiv: 1000 }),
    spd: new Gauge($('g-spd'), { title: 'VELOCIDADE', unit: 'km/h', min: 0, max: 240, major: 20, minor: 4 }),
    ect: new Gauge($('g-ect'), { title: 'TEMP. MOTOR', unit: '°C', min: 40, max: 130, major: 30, minor: 3, redFrom: 110, warnFrom: 104, compact: true }),
    fuel: new Gauge($('g-fuel'), { title: 'COMBUSTÍVEL', unit: '%', min: 0, max: 100, major: 25, minor: 5, lowRed: 12, compact: true }),
    load: new Gauge($('g-load'), { title: 'CARGA', unit: '%', min: 0, max: 100, major: 25, minor: 5, compact: true }),
    thr: new Gauge($('g-thr'), { title: 'ACELERADOR', unit: '%', min: 0, max: 100, major: 25, minor: 5, compact: true })
  };

  const TILE_SPEC = [['bat', 'Bateria', 'V'], ['iat', 'Temp. do ar', '°C'], ['map', 'Pressão coletor', 'kPa'],
    ['maf', 'Fluxo de ar', 'g/s'], ['adv', 'Avanço ignição', '°'], ['cons', 'Consumo (estimado)', 'km/L'],
    ['stft', 'Correção curta B1', '%'], ['ltft', 'Correção longa B1', '%'], ['o2', 'Sonda lambda B1S1', 'V'],
    ['oil', 'Temp. do óleo', '°C'], ['amb', 'Temp. ambiente', '°C'], ['eth', 'Etanol no combustível', '%']];
  const T = {};
  for (const [k, label, unit] of TILE_SPEC) {
    const el = document.createElement('div');
    el.className = 'tile';
    el.innerHTML = `<label>${label}</label><span class="v num">—</span><span class="u">${unit}</span>`;
    $('tiles').append(el);
    T[k] = { el, v: el.querySelector('.v'), u: el.querySelector('.u') };
  }
  function tile(k, text, state = 'normal', unit) {
    const t = T[k];
    t.v.textContent = text;
    t.el.className = 'tile ' + (state === 'none' ? '' : state);
    if (unit) t.u.textContent = unit;
  }
  function lamp(id, state) { $(id).className = 'lamp ' + (state === 'off' ? '' : state); }

  /* ---------- navegação ---------- */
  $('nav').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    document.querySelectorAll('#nav button').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === b.dataset.pane));
    S.pane = b.dataset.pane;
    if (S.engine) S.engine.slowPerCycle = S.pane === 'data-pane' ? 6 : 2;
    if (S.pane === 'data-pane') drawChart(true);
  });

  /* ---------- avisos e diálogos ---------- */
  let toastT;
  function toast(msg, ms = 2800) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
  }
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
  function setStatus(text, color) {
    const s = $('status'); s.querySelector('span').textContent = text;
    s.querySelector('i').style.background = color; s.style.color = color;
  }
  const busy = on => $('progress').classList.toggle('show', on);

  /* ---------- conexão ---------- */
  function openSheet() {
    if (BT && !BT.hasPermission()) {
      window.onBtPermission = ok => { if (ok) openSheet(); else dialog('Permissão necessária', 'Sem a permissão de “Dispositivos próximos/Bluetooth” o app não consegue falar com o adaptador.\n\nVocê pode liberar em Configurações > Apps > Painel OBD > Permissões.'); };
      BT.requestPermission();
      return;
    }
    const list = $('dev-list'); list.innerHTML = '';
    const devs = [];
    if (BT) {
      if (!BT.isEnabled()) list.insertAdjacentHTML('beforeend', '<div class="banner warn">O Bluetooth do celular está desligado. Ligue para ver os adaptadores.</div>');
      try { devs.push(...JSON.parse(BT.paired())); } catch (_) {}
      devs.sort((a, b) => obdLike(b.name) - obdLike(a.name));
    }
    const last = store.get('device');
    const btIcon = '<svg viewBox="0 0 24 24"><path d="M7 7l10 10-5 5V2l5 5L7 17"/></svg>';
    for (const d of devs) {
      const b = document.createElement('button');
      b.className = 'dev' + (obdLike(d.name) ? ' obd' : '');
      b.innerHTML = `${btIcon}<div><b>${esc(d.name || 'Sem nome')}</b><small>${esc(d.addr)}${d.addr === last ? ' · último usado' : ''}</small></div>`;
      b.onclick = () => { closeSheet(); connect('bt', d.addr, d.name); };
      list.append(b);
    }
    if (BT && !devs.length) list.insertAdjacentHTML('beforeend', '<div class="empty">Nenhum aparelho pareado. Toque em “Parear novo adaptador”.</div>');
    const demo = document.createElement('button');
    demo.className = 'dev';
    demo.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4.5 17a8.5 8.5 0 1 1 15 0"/><path d="M12 13l4-4"/></svg><div><b>Demonstração</b><small>Carro simulado, para conhecer o app</small></div>';
    demo.onclick = () => { closeSheet(); connect('demo'); };
    list.append(demo);
    $('sheet-wrap').classList.add('show');
  }
  const obdLike = n => (/OBD|ELM|V-?LINK|VGATE|KONNWEI|VIECAR/i.test(n || '') ? 1 : 0);
  function closeSheet() { $('sheet-wrap').classList.remove('show'); }
  $('sheet-wrap').addEventListener('click', e => { if (e.target.id === 'sheet-wrap') closeSheet(); });
  $('btn-pair').onclick = () => { if (BT) BT.openBluetoothSettings(); else toast('Disponível apenas no app Android'); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden && $('sheet-wrap').classList.contains('show')) openSheet(); });

  $('btn-conn').onclick = () => {
    if (S.engine) { S.engine.stop(); $('btn-conn').disabled = true; $('btn-conn').textContent = 'Saindo…'; return; }
    openSheet();
  };

  function connect(kind, addr, name) {
    S.demo = kind === 'demo';
    if (!S.demo) store.set('device', addr);
    resetSession();
    $('term').textContent = '';
    termWrite(`=== Conexão ${new Date().toLocaleString('pt-BR')} · ${S.demo ? 'demonstração' : (name || '') + ' ' + (addr || '')} ===\n`);
    const tr = S.demo ? new DemoTransport((location.hash.match(/demo-(\w+)/) || [])[1]) : new ELM.BridgeTransport(addr);
    S.engine = new ELM.Engine(tr, onEvent);
    S.engine.slowPerCycle = S.pane === 'data-pane' ? 6 : 2;
    $('btn-conn').textContent = 'Cancelar'; $('btn-conn').classList.remove('accent');
    setStatus(S.demo ? 'Conectando (demo)…' : `Conectando a ${name || addr}…`, 'var(--warn)');
    busy(true);
    S.engine.run();
  }

  function resetSession() {
    S.values = {}; S.raw = {}; S.minmax = {}; S.history = {}; S.supported = []; S.readTimes = [];
    Object.values(G).forEach(g => g.set(null));
    for (const k in T) tile(k, '—', 'none');
    ['l-mil', 'l-temp', 'l-bat', 'l-fuel'].forEach(id => lamp(id, 'off'));
    ['kv-dtc', 'kv-fuelsys', 'kv-runtime', 'kv-dist', 'kv-proto', 'kv-rate'].forEach(id => { $(id).textContent = '—'; $(id).style.color = ''; });
    $('data-list').innerHTML = '';
  }

  /* ---------- eventos do motor ---------- */
  function onEvent(kind, a, b) {
    switch (kind) {
      case 'status': toast(a, 15000); setStatus(a, 'var(--warn)'); break;
      case 'log': termWrite('> ' + a + '\n', 'c'); termWrite((b.join('\n') || '(vazio)') + '\n'); break;
      case 'connected': onConnected(a); break;
      case 'data': onData(a, b); break;
      case 'dtc': onDtc(a); break;
      case 'cleared':
        if (a === 'ok') { toast('Falhas apagadas.'); $('ff-list').innerHTML = '<div class="empty">Sem dados</div>'; }
        else if (a === 'motor') dialog('A central recusou', 'A central do motor não aceitou apagar agora. Confira se o motor está desligado e a ignição ligada (painel aceso) e tente de novo.');
        else dialog('Sem confirmação', 'O carro não confirmou que apagou as falhas. Toque em “Ler falhas” para conferir; se ainda aparecerem, desligue o motor, deixe a ignição ligada e tente de novo.');
        break;
      case 'car':
        if (a) { setStatus(S.demo ? 'Demonstração' : 'Conectado', 'var(--ok)'); toast('Comunicação com o carro restabelecida'); }
        else setStatus('Carro sem resposta…', 'var(--warn)');
        break;
      case 'freeze': onFreeze(a); break;
      case 'readiness': onReadiness(a); toast('Monitores atualizados.'); break;
      case 'raw': termWrite((b.join('\n') || '(sem resposta)') + '\n\n'); break;
      case 'job_error': toast('Erro: ' + b, 4000); if (a === 'raw') termWrite('Erro: ' + b + '\n\n'); break;
      case 'error':
        busy(false); setStatus('Falha na conexão', 'var(--danger)'); S.failed = true; $('toast').classList.remove('show');
        dialog('Não foi possível conectar', a, [['Ver detalhes', ''], ['OK', 'accent']]).then(i => { if (i === 0) document.querySelector('nav button[data-pane="term-pane"]').click(); });
        break;
      case 'disconnected': onDisconnected(); break;
    }
  }

  function onConnected(info) {
    busy(false); $('toast').classList.remove('show');
    S.connected = true; S.info = info;
    S.supported = info.supported.filter(p => !OBD.isBitmap(p));
    setStatus(S.demo ? 'Demonstração' : 'Conectado', 'var(--ok)');
    $('btn-conn').disabled = false; $('btn-conn').textContent = 'Sair';
    toast(`${S.supported.length} parâmetros disponíveis`);
    $('kv-proto').textContent = info.protocol;
    $('v-vin').textContent = info.vin || 'Não informado pelo carro';
    $('v-calid').textContent = info.calid || 'Não informado';
    $('v-ecu').textContent = info.ecu || 'Não informado';
    $('v-proto').textContent = info.protocol;
    $('v-elm').textContent = info.version;
    $('v-count').textContent = `${S.supported.length} PIDs`;
    $('pid-list').innerHTML = S.supported.map(p => `0x${OBD.hex2(p)}  ${esc(OBD.nameOf(p))}`).join('<br>');
    $('data-count').textContent = `${S.supported.length} parâmetros · toque num deles para ver o gráfico`;
    const rows = S.supported.slice().sort((a, b) => OBD.groupOf(a).localeCompare(OBD.groupOf(b)) || a - b);
    $('data-list').innerHTML = `<div class="row" data-pid="V"><div class="n"><b>Tensão na tomada OBD (adaptador)</b><small>Elétrica · ATRV${vcal !== 1 ? ' · calibrada' : ''}</small></div><div class="val"><b class="num" id="dv-V">…</b><span class="u">V</span><small class="num" id="dm-V"></small></div></div>` + rows.map(p => `<div class="row" data-pid="${p}"><div class="n"><b>${esc(OBD.nameOf(p))}</b><small>${esc(OBD.groupOf(p))} · 0x${OBD.hex2(p)}</small></div><div class="val"><b class="num" id="dv-${p}">…</b><span class="u">${esc(OBD.unitOf(p))}</span><small class="num" id="dm-${p}"></small></div></div>`).join('');
    const need = { iat: [0x0F], map: [0x0B], maf: [0x10], adv: [0x0E], stft: [0x06], ltft: [0x07], o2: [0x14, 0x24],
      oil: [0x5C], amb: [0x46], eth: [0x52], cons: [0x5E, 0x10] };
    for (const k in need) if (!need[k].some(p => S.supported.includes(p))) tile(k, 'n/d', 'none');
  }

  function onDisconnected() {
    busy(false);
    S.connected = false; S.engine = null;
    $('btn-conn').disabled = false; $('btn-conn').textContent = 'Conectar'; $('btn-conn').classList.add('accent');
    if (!S.failed) setStatus('Desconectado', 'var(--muted)');
    S.failed = false;
    if (S.rec) stopRecord();
    Object.values(G).forEach(g => g.set(null));
  }

  const num = (...pids) => { for (const p of pids) { const v = S.values[p]; if (typeof v === 'number') return v; } return null; };

  function onData(batch, ts) {
    for (const k in batch) {
      const [raw, val] = batch[k];
      const pid = k === 'V' ? 'V' : Number(k);
      S.values[pid] = val; S.raw[pid] = raw; S.readTimes.push(ts);
      if (typeof val === 'number') {
        (S.history[pid] = S.history[pid] || []).push([ts, val]);
        if (S.history[pid].length > 900) S.history[pid].shift();
        const mm = S.minmax[pid];
        S.minmax[pid] = mm ? [Math.min(mm[0], val), Math.max(mm[1], val)] : [val, val];
      }
      if (S.pane === 'data-pane') updateRow(pid);
    }
    updateDash();
    if (S.waitEngineOff && typeof S.values[0x0C] === 'number' && batch[0x0C] && !engineRunning()) { closeDialog(); confirmClear(); }
    if (S.pane === 'data-pane' && S.chartPid != null && batch[S.chartPid]) drawChart();
    if (S.rec && Date.now() - S.rec.last >= 1000) writeRecord();
  }

  function updateRow(pid) {
    const v = $('dv-' + pid); if (!v) return;
    if (pid === 'V') {
      const x = atrv(), mm = S.minmax.V;
      v.textContent = x == null ? '—' : fmt(x, 2);
      if (mm) $('dm-V').textContent = `mín ${fmt(mm[0] * vcal, 2)} · máx ${fmt(mm[1] * vcal, 2)}`;
      return;
    }
    v.textContent = OBD.fmtValue(pid, S.values[pid], S.raw[pid]);
    const mm = S.minmax[pid];
    if (mm) $('dm-' + pid).textContent = `mín ${OBD.fmtValue(pid, mm[0])} · máx ${OBD.fmtValue(pid, mm[1])}`;
  }

  function consumption() {
    let lph = num(0x5E);
    if (lph == null) {
      const maf = num(0x10); if (maf == null) return null;
      let e = num(0x52); e = e == null ? 0.30 : e / 100; // gasolina brasileira ~30% de etanol
      lph = maf * 3600 / (14.7 * (1 - e) + 9.0 * e) / (745 * (1 - e) + 789 * e);
    }
    const spd = num(0x0D);
    if (spd && spd > 5 && lph > 0.05) return [fmt(Math.min(99.9, spd / lph)), 'km/L'];
    return [fmt(lph, 2), 'L/h'];
  }

  /* ---------- bateria ---------- */
  // O ATRV é medido pelo próprio adaptador; nos clones baratos costuma vir 0,3 a 0,8 V abaixo do real
  // (há um diodo de proteção no caminho). Por isso: 1) usa a tensão da central (PID 42) quando existe;
  // 2) senão usa o ATRV com a calibração que o usuário fizer comparando com um multímetro.
  let vcal = parseFloat(store.get('vcal')) || 1;
  const atrv = () => (typeof S.values.V === 'number' ? S.values.V * vcal : null);
  function battery() {
    const ecu = num(0x42);
    if (ecu != null && ecu > 5) return [ecu, 'central'];
    const v = atrv();
    return v != null ? [v, vcal !== 1 ? 'calibrada' : 'adaptador'] : [null, ''];
  }
  T.bat.el.addEventListener('click', async () => {
    const raw = typeof S.values.V === 'number' ? S.values.V : null;
    if (raw == null) { toast('Conecte ao adaptador para calibrar a tensão'); return; }
    const src = battery()[1];
    const r = await dialog('Calibrar tensão da bateria',
      `Leitura do adaptador agora: ${fmt(raw * vcal, 2)} V${vcal !== 1 ? ' (já calibrada)' : ''}.\n` +
      (src === 'central' ? 'Obs.: este carro informa a tensão pela central, e é ela que aparece no painel. A calibração vale só para a leitura do adaptador.\n' : '') +
      '\nMeça a bateria com um multímetro (nos polos da bateria) e digite o valor real, no mesmo momento, sem desligar nada:',
      [['Cancelar', ''], ['Zerar', ''], ['Salvar', 'accent']], { placeholder: 'Ex.: 12,6', value: '' });
    if (r.i === 1) { vcal = 1; store.set('vcal', '1'); toast('Calibração removida'); }
    if (r.i === 2) {
      const real = parseFloat(String(r.value).replace(',', '.'));
      if (!(real > 8 && real < 17)) { toast('Valor inválido. Digite algo entre 8 e 17 V.'); return; }
      vcal = real / raw; store.set('vcal', String(vcal));
      toast(`Calibrado: correção de ${(real - raw >= 0 ? '+' : '') + fmt(real - raw, 2)} V`);
    }
    updateDash();
  });

  function updateDash() {
    const rpm = num(0x0C), spd = num(0x0D), ect = num(0x05, 0x67), fuel = num(0x2F);
    G.rpm.set(rpm); G.spd.set(spd); G.ect.set(ect); G.fuel.set(fuel);
    // Acelerador: posição RELATIVA (0 % = pé fora), não a absoluta, que já marca 12–20 % em repouso
    G.load.set(num(0x04, 0x43)); G.thr.set(num(0x5A, 0x45, 0x11));
    const [volt, vsrc] = battery();
    if (volt != null) {
      const running = (rpm || 0) > 400;
      // motor ligado: alternador deve dar 13,2–14,8 V · motor desligado: bateria boa 12,2–12,9 V
      const st = volt > 15.2 ? 'danger'
        : running ? (volt < 12.5 ? 'danger' : volt < 13.2 ? 'warn' : 'ok')
        : (volt < 11.8 ? 'danger' : volt < 12.2 ? 'warn' : 'ok');
      tile('bat', fmt(volt), st);
      T.bat.el.querySelector('label').textContent = `Bateria · ${vsrc}`;
      lamp('l-bat', { danger: 'on', warn: 'warn', ok: 'off' }[st]);
    }
    const t = (k, v, d = 0, warn) => { if (v != null) tile(k, fmt(v, d), warn && warn(v) ? 'warn' : 'normal'); };
    t('iat', num(0x0F, 0x68)); t('map', num(0x0B)); t('maf', num(0x10), 1); t('adv', num(0x0E), 1);
    t('stft', num(0x06), 1, v => Math.abs(v) > 15); t('ltft', num(0x07), 1, v => Math.abs(v) > 15);
    const o2 = num(0x14);
    if (o2 != null) t('o2', o2, 2); else if (num(0x24) != null) tile('o2', fmt(num(0x24), 3), 'normal', 'λ');
    t('oil', num(0x5C), 0, v => v > 130); t('amb', num(0x46)); t('eth', num(0x52));
    const c = consumption(); if (c) tile('cons', c[0], 'normal', c[1]);
    if (ect != null) lamp('l-temp', ect >= 110 ? 'on' : ect >= 104 ? 'warn' : 'off');
    if (fuel != null) lamp('l-fuel', fuel < 12 ? 'warn' : 'off');
    const st = S.values[0x01];
    if (typeof st === 'string') lamp('l-mil', st.includes('ACESA') ? 'warn' : 'off');
    if (S.values[0x03]) $('kv-fuelsys').textContent = S.values[0x03];
    const rt = num(0x1F);
    if (rt != null) $('kv-runtime').textContent = [rt / 3600, (rt % 3600) / 60, rt % 60].map(x => String(Math.floor(x)).padStart(2, '0')).join(':');
    const d = num(0x31); if (d != null) $('kv-dist').textContent = `${d} km`;
    if (S.values[0x1C]) $('v-std').textContent = S.values[0x1C];
    if (S.values[0x51]) $('v-fuel').textContent = S.values[0x51];
  }

  setInterval(() => {
    const now = Date.now();
    S.readTimes = S.readTimes.filter(t => t > now - 3000);
    if (S.connected) $('kv-rate').textContent = fmt(S.readTimes.length / 3);
  }, 1000);

  /* ---------- dados ao vivo ---------- */
  const chart = new Chart($('chart'));
  $('data-list').addEventListener('click', e => {
    const r = e.target.closest('.row'); if (!r) return;
    document.querySelectorAll('#data-list .row.sel').forEach(x => x.classList.remove('sel'));
    r.classList.add('sel');
    S.chartPid = r.dataset.pid === 'V' ? 'V' : Number(r.dataset.pid);
    drawChart(true);
  });
  function drawChart(force) {
    if (!force && Date.now() - S.chartLast < 400) return;
    S.chartLast = Date.now();
    if (S.chartPid == null) { chart.set('', '', null); return; }
    if (S.chartPid === 'V') chart.set('Tensão na tomada OBD', 'V', (S.history.V || []).map(([t, x]) => [t, x * vcal]));
    else chart.set(OBD.nameOf(S.chartPid), OBD.unitOf(S.chartPid), S.history[S.chartPid]);
    if (force) { S.supported.forEach(updateRow); updateRow('V'); }
  }
  $('btn-minmax').onclick = () => { S.minmax = {}; document.querySelectorAll('[id^="dm-"]').forEach(x => (x.textContent = '')); toast('Mínimos e máximos zerados'); };

  /* ---------- falhas e prontidão ---------- */
  function job(kind, ...args) {
    if (!S.connected) { toast('Conecte ao carro primeiro'); return false; }
    S.engine.submit(kind, ...args);
    toast({ dtc: 'Lendo códigos de falha…', freeze: 'Lendo congelamento de dados…', readiness: 'Lendo monitores…', clear: 'Apagando falhas…' }[kind] || 'Enviando…');
    return true;
  }
  $('btn-dtc').onclick = () => job('dtc');
  $('btn-freeze').onclick = () => job('freeze');
  $('btn-ready').onclick = () => job('readiness');
  // A maioria das centrais recusa apagar falhas com o motor funcionando.
  // Então o app pede para desligar o motor (mantendo a ignição ligada) e só apaga quando a rotação zerar.
  const engineRunning = () => (num(0x0C) || 0) > 250;
  async function confirmClear() {
    S.waitEngineOff = false;
    const r = await dialog('Apagar falhas?', 'Motor desligado e ignição ligada: tudo certo.\n\nIsso apaga os códigos de falha, o congelamento de dados e zera os monitores de prontidão.\n\n• Se o defeito continuar, a luz de injeção volta a acender.\n• Os monitores de prontidão voltam a “Incompleto” até o carro rodar um pouco.', [['Cancelar', ''], ['Apagar', 'danger']]);
    if (r !== 1) return;
    if (engineRunning()) { toast('O motor foi ligado de novo. Desligue para apagar.'); return; }
    job('clear');
  }
  $('btn-clear').onclick = async () => {
    if (!S.connected) { toast('Conecte ao carro primeiro'); return; }
    if (!engineRunning()) { confirmClear(); return; }
    S.waitEngineOff = true;
    const r = await dialog('Desligue o motor',
      'Para apagar as falhas o motor precisa estar DESLIGADO, com a ignição LIGADA:\n\n' +
      '1. Gire a chave para desligar o motor.\n2. Gire de novo só até acender o painel (sem dar partida).\n\n' +
      'O app vai perceber sozinho e continuar. O adaptador pode perder a comunicação por alguns segundos, é normal.',
      [['Cancelar', '']]);
    if (r === 0) S.waitEngineOff = false;
  };

  function onDtc(res) {
    const html = [];
    for (const [key, label] of [['stored', 'ARMAZENADA'], ['pending', 'PENDENTE'], ['permanent', 'PERMANENTE']])
      for (const code of res[key] || [])
        html.push(`<div class="dtc ${key}"><div class="code">${code}</div><div><span class="tag">${label}</span><div class="d">${esc(DTC.describe(code))}</div></div></div>`);
    $('dtc-list').innerHTML = html.length ? html.join('') : '<div class="empty" style="color:var(--ok)">Nenhuma falha registrada</div>';
    const ns = (res.stored || []).length, np = (res.pending || []).length;
    $('kv-dtc').textContent = `${ns} armazenada(s), ${np} pendente(s)`;
    $('kv-dtc').style.color = html.length ? 'var(--warn)' : 'var(--ok)';
    const rd = res.readiness;
    if (rd) {
      lamp('l-mil', rd.mil ? 'warn' : 'off');
      $('mil-banner').className = 'banner ' + (rd.mil ? 'warn' : 'ok');
      $('mil-banner').textContent = rd.mil ? 'Luz de injeção ACESA' : 'Luz de injeção apagada';
      onReadiness(rd);
    }
    toast(`Leitura concluída: ${html.length} código(s)`);
  }

  function onFreeze(rows) {
    $('ff-list').innerHTML = rows.length
      ? rows.map(r => `<div class="row"><div class="n"><b>${esc(r[0])}</b></div><div class="val"><b class="num">${esc(r[1])}</b><span class="u">${esc(r[2])}</span></div></div>`).join('')
      : '<div class="empty">Nenhum congelamento de dados registrado</div>';
  }

  function onReadiness(rd) {
    if (!rd) { $('ready-list').innerHTML = '<div class="empty">O carro não informou os monitores</div>'; return; }
    const mons = rd.monitors.filter(m => m[1] !== 'nsup').concat(rd.monitors.filter(m => m[1] === 'nsup'));
    const ok = mons.filter(m => m[1] === 'ok').length, inc = mons.filter(m => m[1] === 'inc').length;
    $('ready-sum').textContent = `${ok} pronto(s) · ${inc} incompleto(s)`;
    $('ready-sum').style.color = inc ? 'var(--warn)' : 'var(--ok)';
    const lab = { ok: 'PRONTO', inc: 'INCOMPLETO', nsup: 'NÃO SUPORTADO' };
    $('ready-list').innerHTML = mons.map(([n, s]) => `<div class="mon ${s}"><span>${esc(n)}</span><span class="pill ${s}">${lab[s]}</span></div>`).join('');
  }

  /* ---------- terminal ---------- */
  function termWrite(text, cls) {
    const t = $('term'), span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text; t.append(span); t.scrollTop = t.scrollHeight;
  }
  async function sendRaw(cmd) {
    cmd = (cmd || $('term-in').value).trim().toUpperCase();
    if (!cmd) return;
    if (!S.connected) { toast('Conecte ao adaptador primeiro'); return; }
    if (['ATZ', 'ATWS', 'ATD'].includes(cmd) || /^AT(SP|H|S|E|L)/.test(cmd)) {
      const r = await dialog('Atenção', 'Esse comando muda a configuração do adaptador e pode atrapalhar as leituras do painel até reconectar.', [['Cancelar', ''], ['Enviar', 'accent']]);
      if (r !== 1) return;
    }
    $('term-in').value = '';
    termWrite('> ' + cmd + '\n', 'c');
    S.engine.submit('raw', cmd);
  }
  $('btn-send').onclick = () => sendRaw();
  $('term-in').addEventListener('keydown', e => { if (e.key === 'Enter') sendRaw(); });
  document.querySelectorAll('.chips button').forEach(b => (b.onclick = () => sendRaw(b.dataset.cmd)));

  /* ---------- gravação ---------- */
  $('btn-rec').onclick = () => {
    if (S.rec) { stopRecord(); return; }
    if (!S.connected) { toast('Conecte ao carro para gravar um trajeto'); return; }
    const cols = S.supported.filter(p => OBD.PIDS[p] && p !== 0x01 && p !== 0x41);
    const head = ['data_hora', 'tensao_adaptador_V', ...cols.map(p => OBD.unitOf(p) ? `${OBD.nameOf(p)} (${OBD.unitOf(p)})` : OBD.nameOf(p))];
    S.rec = { cols, lines: [head.join(';')], last: 0, start: new Date() };
    $('btn-rec').classList.add('on'); $('btn-rec').textContent = '■ REC';
    toast('Gravando trajeto…');
  };
  const cell = v => (v == null ? '' : typeof v === 'number' ? String(Math.round(v * 1000) / 1000).replace('.', ',') : `"${String(v).replace(/"/g, "'")}"`);
  const stamp = d => d.toISOString().slice(0, 19).replace('T', ' ');
  function writeRecord() {
    S.rec.last = Date.now();
    const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
    S.rec.lines.push([stamp(now), cell(atrv()), ...S.rec.cols.map(p => cell(S.values[p]))].join(';'));
  }
  function stopRecord() {
    const rec = S.rec; S.rec = null;
    $('btn-rec').classList.remove('on'); $('btn-rec').textContent = '● REC';
    const d = new Date(rec.start.getTime() - rec.start.getTimezoneOffset() * 60000);
    const name = `trajeto_${d.toISOString().slice(0, 19).replace(/[T:]/g, '-')}.csv`;
    const csv = '﻿' + rec.lines.join('\n');
    if (BT) {
      const where = BT.saveFile(name, csv);
      if (where) dialog('Trajeto salvo', `${rec.lines.length - 1} linha(s) gravadas.\n\nArquivo: ${where}`);
      else dialog('Erro', 'Não foi possível salvar o arquivo.');
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = name; a.click();
    }
  }

  window.PainelOBD = { S, connect }; // usado nos testes
  if (/demo/.test(location.hash)) setTimeout(() => connect('demo'), 300);
})();
