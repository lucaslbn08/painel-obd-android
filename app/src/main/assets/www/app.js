/* Painel OBD – conexão, painel, dados ao vivo, falhas, prontidão, terminal e gravação. */
(function () {
  const { $, BT, fmt, esc, store, settings, toast, hideToast, dialog, closeDialog, show, emit, on } = U;

  const S = { engine: null, connected: false, demo: false, values: {}, raw: {}, minmax: {}, history: {},
    supported: [], readTimes: [], rec: null, chartPid: null, chartLast: 0, lastDtc: null, lastFreeze: null, info: null };
  const num = (...pids) => { for (const p of pids) { const v = S.values[p]; if (typeof v === 'number') return v; } return null; };
  const has = p => S.supported.includes(p);

  /* ================= bateria ================= */
  // O ATRV é medido pelo adaptador; nos clones costuma vir 0,3 a 0,8 V abaixo do real (diodo de proteção).
  // 1) usa a tensão da central (PID 42) quando existe; 2) senão o ATRV com a calibração do usuário.
  let vcal = parseFloat(store.get('vcal')) || 1;
  const atrv = () => (typeof S.values.V === 'number' ? S.values.V * vcal : null);
  function battery() {
    const ecu = num(0x42);
    if (ecu != null && ecu > 5) return [ecu, 'central'];
    const v = atrv();
    return v != null ? [v, vcal !== 1 ? 'calibrada' : 'adaptador'] : [null, ''];
  }
  const engineRunning = () => (num(0x0C) || 0) > 250;
  function batteryState(v) {
    if (v == null) return 'none';
    const running = engineRunning();
    return v > 15.2 ? 'danger' : running ? (v < 12.5 ? 'danger' : v < 13.2 ? 'warn' : 'ok') : (v < 11.8 ? 'danger' : v < 12.2 ? 'warn' : 'ok');
  }
  async function calibrateBattery() {
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
      const real = U.parseNum(r.value);
      if (!(real > 8 && real < 17)) { toast('Valor inválido. Digite algo entre 8 e 17 V.'); return; }
      vcal = real / raw; store.set('vcal', String(vcal));
      toast(`Calibrado: correção de ${(real - raw >= 0 ? '+' : '') + fmt(real - raw, 2)} V`);
    }
    updateDash();
  }

  /* ================= consumo ================= */
  // Combustíveis: relação ar/combustível estequiométrica e densidade (kg/L)
  const FUELS = {
    gasolina: { label: 'Gasolina comum (com etanol)', mix: true },
    etanol: { label: 'Etanol', afr: 8.7, dens: 0.809 },
    flex: { label: 'Flex (usa o teor de etanol do carro)', mix: true, auto: true },
    diesel: { label: 'Diesel', afr: 14.5, dens: 0.835 },
    pura: { label: 'Gasolina pura (sem etanol)', afr: 14.7, dens: 0.745 }
  };
  function fuelProps() {
    const f = FUELS[settings.fuel] || FUELS.gasolina;
    if (!f.mix) return f;
    let e = settings.ethanolPct / 100;
    if (f.auto && num(0x52) != null) e = num(0x52) / 100;
    return { afr: 14.7 * (1 - e) + 9.0 * e, dens: 0.745 * (1 - e) + 0.789 * e };
  }
  /** Fluxo de ar em g/s: sensor MAF, ou estimado pela pressão do coletor (método "speed-density"). */
  function airFlow() {
    const maf = num(0x10);
    if (maf != null) return [maf, 'MAF'];
    const map = num(0x0B), rpm = num(0x0C);
    if (map == null || rpm == null) return [null, ''];
    const iat = num(0x0F, 0x68), T = (iat == null ? 30 : iat) + 273.15;
    // massa de ar = (rpm/120) · eficiência volumétrica · cilindrada(L) · MAP(kPa) · 28,97 / (8,314 · T)
    return [(rpm / 120) * (settings.ve / 100) * settings.disp * map * 28.97 / (8.314 * T), 'MAP'];
  }
  /** Consumo instantâneo em L/h (ou null) */
  function fuelRate() {
    if (num(0x5E) != null) return num(0x5E) * settings.consFactor;
    const [air] = airFlow();
    if (air == null) return null;
    const rpm = num(0x0C) || 0;
    if (rpm < 300) return 0;
    // corte de combustível em desaceleração (malha aberta por desaceleração + pé fora)
    const fs = S.raw[0x03] ? parseInt(S.raw[0x03].split(' ')[0], 16) : 0;
    const thr = num(0x5A, 0x45, 0x11);
    if (fs === 4 && rpm > 1100 && (thr == null || thr < 3)) return 0;
    const trim = 1 + ((num(0x06) || 0) + (num(0x07) || 0)) / 100;
    const { afr, dens } = fuelProps();
    return Math.max(0, air / afr * trim * 3600 / (dens * 1000)) * settings.consFactor;
  }
  function consumptionNow() {
    const lph = fuelRate(); if (lph == null) return null;
    const spd = num(0x0D) || 0;
    if (spd > 5) return { v: lph > 0.05 ? Math.min(99.9, spd / lph) : 99.9, unit: 'km/L' };
    return { v: lph, unit: 'L/h' };
  }

  /* ================= catálogo de dados para o painel ================= */
  // g = escala do mostrador · warn/danger = cor do bloco · pids = o que precisa ler
  const TRIP = () => (window.Trips && Trips.current()) || null;
  const M = {
    rpm: { label: 'Rotação', short: 'ROTAÇÃO', unit: 'rpm', d: 0, pids: [0x0C], get: () => num(0x0C), g: { min: 0, max: 8000, major: 2000, minor: 4, redFrom: 6500 } },
    speed: { label: 'Velocidade', short: 'VELOCIDADE', unit: 'km/h', d: 0, pids: [0x0D], get: () => num(0x0D), g: { min: 0, max: 240, major: 60, minor: 3 } },
    ect: { label: 'Temperatura do motor', short: 'TEMP. MOTOR', unit: '°C', d: 0, pids: [0x05, 0x67], get: () => num(0x05, 0x67), g: { min: 40, max: 130, major: 30, minor: 3, redFrom: 110, warnFrom: 104 }, warn: v => v >= 104 },
    oil: { label: 'Temperatura do óleo', short: 'TEMP. ÓLEO', unit: '°C', d: 0, pids: [0x5C], get: () => num(0x5C), g: { min: 40, max: 150, major: 30, minor: 3, redFrom: 130 }, warn: v => v > 130 },
    iat: { label: 'Temperatura do ar', short: 'TEMP. AR', unit: '°C', d: 0, pids: [0x0F, 0x68], get: () => num(0x0F, 0x68), g: { min: -10, max: 80, major: 30, minor: 3 } },
    amb: { label: 'Temperatura ambiente', short: 'AMBIENTE', unit: '°C', d: 0, pids: [0x46], get: () => num(0x46), g: { min: -10, max: 50, major: 20, minor: 4 } },
    fuel: { label: 'Nível de combustível', short: 'COMBUSTÍVEL', unit: '%', d: 0, pids: [0x2F], get: () => num(0x2F), g: { min: 0, max: 100, major: 25, minor: 5, lowRed: 12 }, warn: v => v < 12 },
    load: { label: 'Carga do motor', short: 'CARGA', unit: '%', d: 0, pids: [0x04, 0x43], get: () => num(0x04, 0x43), g: { min: 0, max: 100, major: 25, minor: 5 } },
    thr: { label: 'Acelerador (posição relativa)', short: 'ACELERADOR', unit: '%', d: 0, pids: [0x5A, 0x45, 0x11], get: () => num(0x5A, 0x45, 0x11), g: { min: 0, max: 100, major: 25, minor: 5 } },
    map: { label: 'Pressão do coletor', short: 'COLETOR', unit: 'kPa', d: 0, pids: [0x0B], get: () => num(0x0B), g: { min: 0, max: 120, major: 30, minor: 3 } },
    maf: { label: 'Fluxo de ar', short: 'FLUXO AR', unit: 'g/s', d: 1, pids: [0x10, 0x0B, 0x0C], get: () => airFlow()[0], g: { min: 0, max: 100, major: 25, minor: 5 } },
    baro: { label: 'Pressão barométrica', short: 'BAROM.', unit: 'kPa', d: 0, pids: [0x33], get: () => num(0x33), g: { min: 60, max: 110, major: 10, minor: 2 } },
    adv: { label: 'Avanço de ignição', short: 'AVANÇO', unit: '°', d: 1, pids: [0x0E], get: () => num(0x0E), g: { min: -10, max: 50, major: 20, minor: 4 } },
    bat: { label: 'Bateria', short: 'BATERIA', unit: 'V', d: 1, pids: [0x42], get: () => battery()[0], g: { min: 10, max: 16, major: 2, minor: 4, lowRed: 11.8, redFrom: 15.2 }, state: v => batteryState(v) },
    cons: { label: 'Consumo instantâneo', short: 'CONSUMO', unit: 'km/L', d: 1, pids: [0x5E, 0x10, 0x0B, 0x0C, 0x0D, 0x0F], get: () => (consumptionNow() || {}).v, unitFn: () => (consumptionNow() || {}).unit || 'km/L', g: { min: 0, max: 30, major: 10, minor: 5 } },
    lph: { label: 'Consumo por hora', short: 'L/HORA', unit: 'L/h', d: 2, pids: [0x5E, 0x10, 0x0B, 0x0C], get: () => fuelRate(), g: { min: 0, max: 20, major: 5, minor: 5 } },
    tripavg: { label: 'Média da viagem', short: 'MÉDIA', unit: 'km/L', d: 1, pids: [], get: () => { const t = TRIP(); return t && t.fuel > 0.02 && t.km > 0.2 ? t.km / t.fuel : null; }, g: { min: 0, max: 25, major: 5, minor: 5 } },
    tripkm: { label: 'Distância da viagem', short: 'VIAGEM', unit: 'km', d: 1, pids: [], get: () => { const t = TRIP(); return t ? t.km : null; }, g: { min: 0, max: 500, major: 100, minor: 4 } },
    tripl: { label: 'Combustível gasto na viagem', short: 'GASTO', unit: 'L', d: 2, pids: [], get: () => { const t = TRIP(); return t ? t.fuel : null; }, g: { min: 0, max: 50, major: 10, minor: 5 } },
    stft: { label: 'Correção curta B1', short: 'CORR. CURTA', unit: '%', d: 1, pids: [0x06], get: () => num(0x06), g: { min: -25, max: 25, major: 10, minor: 2, lowRed: -15, redFrom: 15 }, warn: v => Math.abs(v) > 15 },
    ltft: { label: 'Correção longa B1', short: 'CORR. LONGA', unit: '%', d: 1, pids: [0x07], get: () => num(0x07), g: { min: -25, max: 25, major: 10, minor: 2, lowRed: -15, redFrom: 15 }, warn: v => Math.abs(v) > 15 },
    o2: { label: 'Sonda lambda B1S1', short: 'SONDA S1', unit: 'V', d: 2, pids: [0x14], get: () => num(0x14), g: { min: 0, max: 1, major: 0.25, minor: 5 } },
    o2b: { label: 'Sonda lambda B1S2', short: 'SONDA S2', unit: 'V', d: 2, pids: [0x15], get: () => num(0x15), g: { min: 0, max: 1, major: 0.25, minor: 5 } },
    lambda: { label: 'Lambda (banda larga)', short: 'LAMBDA', unit: 'λ', d: 3, pids: [0x24, 0x34, 0x44], get: () => num(0x24, 0x34, 0x44), g: { min: 0.6, max: 1.4, major: 0.2, minor: 4 } },
    cat: { label: 'Temperatura do catalisador', short: 'CATALISADOR', unit: '°C', d: 0, pids: [0x3C], get: () => num(0x3C), g: { min: 0, max: 1000, major: 250, minor: 5, redFrom: 900 } },
    eth: { label: 'Etanol no combustível', short: 'ETANOL', unit: '%', d: 0, pids: [0x52], get: () => num(0x52), g: { min: 0, max: 100, major: 25, minor: 5 } },
    torque: { label: 'Torque do motor', short: 'TORQUE', unit: '%', d: 0, pids: [0x62], get: () => num(0x62), g: { min: 0, max: 100, major: 25, minor: 5 } },
    fp: { label: 'Pressão de combustível', short: 'PRES. COMB.', unit: 'kPa', d: 0, pids: [0x0A, 0x23, 0x59], get: () => num(0x0A, 0x23, 0x59), g: { min: 0, max: 600, major: 150, minor: 3 } },
    egr: { label: 'EGR comandada', short: 'EGR', unit: '%', d: 0, pids: [0x2C], get: () => num(0x2C), g: { min: 0, max: 100, major: 25, minor: 5 } },
    runtime: { label: 'Motor ligado há', short: 'LIGADO HÁ', unit: '', d: 0, pids: [0x1F], get: () => num(0x1F), text: v => [v / 3600, (v % 3600) / 60, v % 60].map(x => String(Math.floor(x)).padStart(2, '0')).join(':') }
  };
  const available = id => { const m = M[id]; if (!m) return false; if (!m.pids.length) return true; return m.pids.some(has); };

  /* ================= painel (montado conforme a personalização) ================= */
  const G = {
    rpm: new Gauge($('g-rpm'), { title: 'ROTAÇÃO', unit: 'rpm ×1000', min: 0, max: 8000, major: 1000, minor: 5, redFrom: 6500, labelDiv: 1000 }),
    spd: new Gauge($('g-spd'), { title: 'VELOCIDADE', unit: 'km/h', min: 0, max: 240, major: 20, minor: 4 })
  };
  let small = [], tiles = [];
  function buildDash() {
    const sw = $('small-gauges'); sw.innerHTML = '';
    small = settings.dash.small.map(id => {
      const m = M[id] || M.ect, el = document.createElement('div');
      el.className = 'gauge'; sw.append(el);
      return { id, m, g: new Gauge(el, Object.assign({ title: m.short, unit: m.unit, compact: true }, m.g)) };
    });
    const tw = $('tiles'); tw.innerHTML = '';
    tiles = settings.dash.tiles.filter(id => M[id]).map(id => {
      const m = M[id], el = document.createElement('div');
      el.className = 'tile'; el.dataset.metric = id;
      el.innerHTML = `<label>${esc(m.label)}</label><span class="v num">—</span><span class="u">${esc(m.unit)}</span>`;
      tw.append(el);
      return { id, m, el, v: el.querySelector('.v'), u: el.querySelector('.u'), l: el.querySelector('label') };
    });
    if (S.connected) { markUnavailable(); setPriorities(); }
    updateDash();
  }
  $('tiles').addEventListener('click', e => { const t = e.target.closest('.tile'); if (t && t.dataset.metric === 'bat') calibrateBattery(); });
  function setTile(t, text, state, unit) {
    t.v.textContent = text;
    t.el.className = 'tile ' + (state === 'none' ? '' : state || 'normal');
    if (unit != null) t.u.textContent = unit;
  }
  function markUnavailable() { for (const t of tiles) if (!available(t.id)) setTile(t, 'n/d', 'none'); }
  function lamp(id, state) { $(id).className = 'lamp ' + (state === 'off' ? '' : state); }

  function updateDash() {
    G.rpm.set(num(0x0C)); G.spd.set(num(0x0D));
    for (const s of small) s.g.set(available(s.id) ? s.m.get() : null);
    for (const t of tiles) {
      if (S.connected && !available(t.id)) continue;
      const v = t.m.get();
      if (v == null) continue;
      const state = t.m.state ? t.m.state(v) : t.m.warn && t.m.warn(v) ? 'warn' : 'normal';
      setTile(t, t.m.text ? t.m.text(v) : fmt(v, t.m.d), state, t.m.unitFn ? t.m.unitFn() : null);
      if (t.id === 'bat') t.l.textContent = `Bateria · ${battery()[1] || '—'}`;
    }
    const [volt] = battery(); const bs = batteryState(volt);
    if (volt != null) lamp('l-bat', { danger: 'on', warn: 'warn', ok: 'off' }[bs] || 'off');
    const ect = num(0x05, 0x67), fuel = num(0x2F);
    if (ect != null) lamp('l-temp', ect >= Math.max(106, settings.alerts.temp + 5) ? 'on' : ect >= settings.alerts.temp ? 'warn' : 'off');
    if (fuel != null) lamp('l-fuel', fuel < 12 ? 'warn' : 'off');
    const st = S.values[0x01];
    if (typeof st === 'string') lamp('l-mil', st.includes('ACESA') ? 'warn' : 'off');
    if (S.values[0x03]) $('kv-fuelsys').textContent = S.values[0x03];
    const rt = num(0x1F); if (rt != null) $('kv-runtime').textContent = M.runtime.text(rt);
    const d = num(0x31); if (d != null) $('kv-dist').textContent = `${d} km`;
    if (S.values[0x1C]) $('v-std').textContent = S.values[0x1C];
    if (S.values[0x51]) $('v-fuel').textContent = S.values[0x51];
  }

  /** Diz ao motor de leitura o que ler mais vezes, conforme o que está na tela */
  function setPriorities() {
    const e = S.engine; if (!e) return;
    const fast = [0x0C, 0x0D];
    if (has(0x5E)) fast.push(0x5E); else if (has(0x10)) fast.push(0x10); else if (has(0x0B)) fast.push(0x0B);
    const med = new Set([0x05, 0x01, 0x03, 0x06, 0x07, 0x0F, 0x5A, 0x45, 0x11, 0x42]);
    for (const s of small) M[s.id].pids.forEach(p => med.add(p));
    for (const t of tiles) M[t.id].pids.forEach(p => med.add(p));
    e.fast = fast; e.medium = [...med];
    e.mediumPerCycle = 2;
    e.slowPerCycle = U.pane === 'data-pane' ? 6 : 1;
  }
  U.on('pane', id => { setPriorities(); if (id === 'data-pane') drawChart(true); });

  /* ================= conexão ================= */
  const busy = on => $('progress').classList.toggle('show', on);
  function setStatus(text, color) {
    const s = $('status'); s.querySelector('span').textContent = text;
    s.querySelector('i').style.background = color; s.style.color = color;
  }
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
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if ($('sheet-wrap').classList.contains('show')) openSheet();
    autoTick(true);
  });

  $('btn-conn').onclick = () => {
    if (S.engine) { S.userStop = true; S.engine.stop(); $('btn-conn').disabled = true; $('btn-conn').textContent = 'Saindo…'; return; }
    S.userStop = true; // usuário assumiu o controle: pausa a reconexão automática até conectar
    openSheet();
  };

  function connect(kind, addr, name, auto = false) {
    S.demo = kind === 'demo'; S.auto = auto; S.userStop = false;
    if (!S.demo) store.set('device', addr), store.set('deviceName', name || '');
    resetSession();
    $('term').textContent = '';
    termWrite(`=== Conexão ${new Date().toLocaleString('pt-BR')} · ${S.demo ? 'demonstração' : (name || '') + ' ' + (addr || '')}${auto ? ' (automática)' : ''} ===\n`);
    const tr = S.demo ? new DemoTransport((location.hash.match(/demo-(\w+)/) || [])[1]) : new ELM.BridgeTransport(addr);
    S.engine = new ELM.Engine(tr, onEvent);
    setPriorities();
    $('btn-conn').textContent = 'Cancelar'; $('btn-conn').classList.remove('accent');
    setStatus(auto ? 'Procurando adaptador…' : S.demo ? 'Conectando (demo)…' : `Conectando a ${name || addr}…`, 'var(--warn)');
    busy(true);
    S.engine.run();
  }

  /* ---------- conexão automática ---------- */
  // Ao abrir o app (e enquanto ele estiver aberto e desconectado) tenta o último adaptador usado.
  let autoTimer = null, lastAuto = 0;
  function autoTick(now) {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => autoTick(false), 15000);
    if (!settings.autoConnect || !BT || S.engine || S.userStop || document.hidden) return;
    if ($('sheet-wrap').classList.contains('show')) return;
    const addr = store.get('device'); if (!addr) return;
    if (!BT.hasPermission() || !BT.isEnabled()) return;
    if (!now && Date.now() - lastAuto < 14000) return;
    lastAuto = Date.now();
    connect('bt', addr, store.get('deviceName'), true);
  }
  setTimeout(() => autoTick(true), 800);

  function resetSession() {
    S.values = {}; S.raw = {}; S.minmax = {}; S.history = {}; S.supported = []; S.readTimes = [];
    G.rpm.set(null); G.spd.set(null);
    for (const s of small) s.g.set(null);
    for (const t of tiles) setTile(t, '—', 'none');
    ['l-mil', 'l-temp', 'l-bat', 'l-fuel'].forEach(id => lamp(id, 'off'));
    ['kv-dtc', 'kv-fuelsys', 'kv-runtime', 'kv-dist', 'kv-proto', 'kv-rate'].forEach(id => { $(id).textContent = '—'; $(id).style.color = ''; });
    $('data-list').innerHTML = '';
  }

  function onEvent(kind, a, b) {
    switch (kind) {
      case 'status': if (!S.auto) toast(a, 15000); setStatus(S.auto ? 'Procurando adaptador…' : a, 'var(--warn)'); break;
      case 'log': termWrite('> ' + a + '\n', 'c'); termWrite((b.join('\n') || '(vazio)') + '\n'); break;
      case 'connected': onConnected(a); break;
      case 'data': onData(a, b); break;
      case 'dtc': onDtc(a, b); break;
      case 'freeze': onFreeze(a); break;
      case 'report': emit('report', a, b); break;
      case 'cleared': onCleared(a); break;
      case 'car':
        if (a) { setStatus(S.demo ? 'Demonstração' : 'Conectado', 'var(--ok)'); toast('Comunicação com o carro restabelecida'); }
        else setStatus('Carro sem resposta…', 'var(--warn)');
        emit('car', a);
        break;
      case 'readiness': onReadiness(a); toast('Monitores atualizados.'); break;
      case 'raw': termWrite((b.join('\n') || '(sem resposta)') + '\n\n'); break;
      case 'job_error': toast('Erro: ' + b, 4000); if (a === 'raw') termWrite('Erro: ' + b + '\n\n'); break;
      case 'error':
        busy(false); S.failed = true; hideToast();
        if (S.auto) { setStatus('Adaptador não encontrado', 'var(--muted)'); break; }
        setStatus('Falha na conexão', 'var(--danger)');
        dialog('Não foi possível conectar', a, [['Ver detalhes', ''], ['OK', 'accent']]).then(i => { if (i === 0) show('term-pane'); });
        break;
      case 'disconnected': onDisconnected(); break;
    }
  }

  function onConnected(info) {
    busy(false); hideToast();
    S.connected = true; S.info = info; S.auto = false;
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
    const calc = `<div class="row" data-pid="V"><div class="n"><b>Tensão na tomada OBD (adaptador)</b><small>Elétrica · ATRV${vcal !== 1 ? ' · calibrada' : ''}</small></div><div class="val"><b class="num" id="dv-V">…</b><span class="u">V</span><small class="num" id="dm-V"></small></div></div>` +
      `<div class="row" data-pid="LPH"><div class="n"><b>Consumo calculado</b><small>Combustível · ${has(0x5E) ? 'informado pela central' : has(0x10) ? 'pelo sensor de fluxo de ar' : 'pela pressão do coletor e cilindrada'}</small></div><div class="val"><b class="num" id="dv-LPH">…</b><span class="u">L/h</span><small class="num" id="dm-LPH"></small></div></div>`;
    $('data-list').innerHTML = calc + rows.map(p => `<div class="row" data-pid="${p}"><div class="n"><b>${esc(OBD.nameOf(p))}</b><small>${esc(OBD.groupOf(p))} · 0x${OBD.hex2(p)}</small></div><div class="val"><b class="num" id="dv-${p}">…</b><span class="u">${esc(OBD.unitOf(p))}</span><small class="num" id="dm-${p}"></small></div></div>`).join('');
    markUnavailable();
    setPriorities();
    emit('connected', info);
  }

  function onDisconnected() {
    busy(false);
    const wasConnected = S.connected;
    S.connected = false; S.engine = null;
    $('btn-conn').disabled = false; $('btn-conn').textContent = 'Conectar'; $('btn-conn').classList.add('accent');
    if (!S.failed) setStatus('Desconectado', 'var(--muted)');
    S.failed = false;
    if (S.rec) stopRecord();
    G.rpm.set(null); G.spd.set(null); for (const s of small) s.g.set(null);
    emit('disconnected', wasConnected);
    if (wasConnected && !S.userStop) { S.userStop = false; setTimeout(() => autoTick(true), 3000); }
  }

  function onData(batch, ts) {
    for (const k in batch) {
      const [raw, val] = batch[k];
      const pid = k === 'V' ? 'V' : Number(k);
      S.values[pid] = val; S.raw[pid] = raw; S.readTimes.push(ts);
      if (typeof val === 'number') pushHist(pid, ts, val);
      if (U.pane === 'data-pane') updateRow(pid);
    }
    const lph = fuelRate();
    if (lph != null && (batch[0x0C] || batch[0x10] || batch[0x0B] || batch[0x5E])) { pushHist('LPH', ts, lph); if (U.pane === 'data-pane') updateRow('LPH'); }
    updateDash();
    if (S.waitEngineOff && typeof S.values[0x0C] === 'number' && batch[0x0C] && !engineRunning()) { closeDialog(); confirmClear(true); }
    if (U.pane === 'data-pane' && S.chartPid != null && (batch[S.chartPid] || S.chartPid === 'LPH')) drawChart();
    if (S.rec && Date.now() - S.rec.last >= 1000) writeRecord();
    emit('data', batch, ts);
  }
  function pushHist(pid, ts, val) {
    const h = (S.history[pid] = S.history[pid] || []);
    h.push([ts, val]); if (h.length > 900) h.shift();
    const mm = S.minmax[pid];
    S.minmax[pid] = mm ? [Math.min(mm[0], val), Math.max(mm[1], val)] : [val, val];
  }

  function updateRow(pid) {
    const v = $('dv-' + pid); if (!v) return;
    const mm = S.minmax[pid];
    if (pid === 'V') {
      const x = atrv();
      v.textContent = x == null ? '—' : fmt(x, 2);
      if (mm) $('dm-V').textContent = `mín ${fmt(mm[0] * vcal, 2)} · máx ${fmt(mm[1] * vcal, 2)}`;
      return;
    }
    if (pid === 'LPH') {
      const x = fuelRate(); v.textContent = x == null ? '—' : fmt(x, 2);
      if (mm) $('dm-LPH').textContent = `mín ${fmt(mm[0], 2)} · máx ${fmt(mm[1], 2)}`;
      return;
    }
    v.textContent = OBD.fmtValue(pid, S.values[pid], S.raw[pid]);
    if (mm) $('dm-' + pid).textContent = `mín ${OBD.fmtValue(pid, mm[0])} · máx ${OBD.fmtValue(pid, mm[1])}`;
  }

  setInterval(() => {
    const now = Date.now();
    S.readTimes = S.readTimes.filter(t => t > now - 3000);
    if (S.connected) $('kv-rate').textContent = fmt(S.readTimes.length / 3);
  }, 1000);

  /* ================= dados ao vivo ================= */
  const chart = new Chart($('chart'));
  $('data-list').addEventListener('click', e => {
    const r = e.target.closest('.row'); if (!r) return;
    document.querySelectorAll('#data-list .row.sel').forEach(x => x.classList.remove('sel'));
    r.classList.add('sel');
    S.chartPid = /^[A-Z]+$/.test(r.dataset.pid) ? r.dataset.pid : Number(r.dataset.pid);
    drawChart(true);
  });
  function drawChart(force) {
    if (!force && Date.now() - S.chartLast < 400) return;
    S.chartLast = Date.now();
    const p = S.chartPid;
    if (p == null) { chart.set('', '', null); return; }
    if (p === 'V') chart.set('Tensão na tomada OBD', 'V', (S.history.V || []).map(([t, x]) => [t, x * vcal]));
    else if (p === 'LPH') chart.set('Consumo calculado', 'L/h', S.history.LPH);
    else chart.set(OBD.nameOf(p), OBD.unitOf(p), S.history[p]);
    if (force) { S.supported.forEach(updateRow); updateRow('V'); updateRow('LPH'); }
  }
  $('btn-minmax').onclick = () => { S.minmax = {}; document.querySelectorAll('[id^="dm-"]').forEach(x => (x.textContent = '')); toast('Mínimos e máximos zerados'); };

  /* ================= falhas ================= */
  function job(kind, ...args) {
    if (!S.connected) { toast('Conecte ao carro primeiro'); return false; }
    S.engine.submit(kind, ...args);
    const msg = { dtc: 'Lendo códigos de falha…', freeze: 'Lendo congelamento de dados…', readiness: 'Lendo monitores…', clear: 'Apagando falhas…', report: 'Lendo tudo para o relatório…' }[kind];
    if (msg) toast(msg);
    return true;
  }
  $('btn-dtc').onclick = () => job('dtc');
  $('btn-freeze').onclick = () => job('freeze');
  $('btn-ready').onclick = () => job('readiness');

  // Tenta apagar com o motor funcionando (3 tentativas). Se a central recusar, oferece desligar o
  // motor mantendo a ignição ligada: o app percebe e apaga na hora.
  async function confirmClear(afterOff) {
    S.waitEngineOff = false;
    const r = await dialog('Apagar falhas?', (afterOff ? 'Motor desligado e ignição ligada: tudo certo.\n\n' : '') + 'Isso apaga os códigos de falha, o congelamento de dados e zera os monitores de prontidão.\n\n• Se o defeito continuar, a luz de injeção volta a acender.\n• Os monitores de prontidão voltam a “Incompleto” até o carro rodar um pouco.', [['Cancelar', ''], ['Apagar', 'danger']]);
    if (r !== 1) return;
    S.clearWithEngine = engineRunning();
    job('clear');
  }
  $('btn-clear').onclick = () => { if (!S.connected) { toast('Conecte ao carro primeiro'); return; } confirmClear(false); };
  async function waitEngineOffAndClear() {
    S.waitEngineOff = true;
    const r = await dialog('Desligue o motor',
      'A central do seu carro só aceita apagar com o motor DESLIGADO e a ignição LIGADA:\n\n' +
      '1. Gire a chave para desligar o motor.\n2. Gire de novo só até acender o painel (sem dar partida).\n\n' +
      'O app vai perceber sozinho e continuar. O adaptador pode perder a comunicação por alguns segundos, é normal.',
      [['Cancelar', '']]);
    if (r === 0) S.waitEngineOff = false;
  }
  function onCleared(a) {
    if (a === 'ok') { toast('Falhas apagadas.'); $('ff-list').innerHTML = '<div class="empty">Sem dados</div>'; S.lastFreeze = []; emit('cleared'); }
    else if (S.clearWithEngine)
      dialog('A central recusou com o motor ligado',
        (a === 'motor' ? 'A central do motor respondeu “condições incorretas”: ela tem uma proteção que bloqueia apagar falhas com o motor funcionando.'
          : 'O carro não confirmou que apagou as falhas (3 tentativas com o motor ligado).') +
        '\n\nEssa trava fica dentro da central do carro, então nenhum app consegue passar por cima dela pelo OBD-II.\n\nQuer apagar desligando o motor só por alguns segundos? O app espera, apaga e depois é só dar partida de novo.',
        [['Agora não', ''], ['Sim, vou desligar', 'accent']]).then(i => { if (i === 1) waitEngineOffAndClear(); });
    else if (a === 'motor') dialog('A central recusou', 'A central do motor não aceitou apagar agora. Confira se a ignição está ligada (painel aceso) e tente de novo.');
    else dialog('Sem confirmação', 'O carro não confirmou que apagou as falhas. Toque em “Ler falhas” para conferir e tente de novo.');
  }

  function onDtc(res, quiet) {
    S.lastDtc = res; S.lastDtcAt = new Date();
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
    if (!quiet) toast(`Leitura concluída: ${html.length} código(s)`);
    emit('dtc', res);
  }
  function onFreeze(rows) {
    S.lastFreeze = rows;
    $('ff-list').innerHTML = rows.length
      ? rows.map(r => `<div class="row"><div class="n"><b>${esc(r[0])}</b></div><div class="val"><b class="num">${esc(r[1])}</b><span class="u">${esc(r[2])}</span></div></div>`).join('')
      : '<div class="empty">Nenhum congelamento de dados registrado</div>';
  }
  function onReadiness(rd) {
    S.lastReady = rd;
    if (!rd) { $('ready-list').innerHTML = '<div class="empty">O carro não informou os monitores</div>'; return; }
    const mons = rd.monitors.filter(m => m[1] !== 'nsup').concat(rd.monitors.filter(m => m[1] === 'nsup'));
    const ok = mons.filter(m => m[1] === 'ok').length, inc = mons.filter(m => m[1] === 'inc').length;
    $('ready-sum').textContent = `${ok} pronto(s) · ${inc} incompleto(s)`;
    $('ready-sum').style.color = inc ? 'var(--warn)' : 'var(--ok)';
    const lab = { ok: 'PRONTO', inc: 'INCOMPLETO', nsup: 'NÃO SUPORTADO' };
    $('ready-list').innerHTML = mons.map(([n, s]) => `<div class="mon ${s}"><span>${esc(n)}</span><span class="pill ${s}">${lab[s]}</span></div>`).join('');
  }

  /* ================= terminal ================= */
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

  /* ================= gravação de trajeto (CSV) ================= */
  $('btn-rec').onclick = () => {
    if (S.rec) { stopRecord(); return; }
    if (!S.connected) { toast('Conecte ao carro para gravar um trajeto'); return; }
    const cols = S.supported.filter(p => OBD.PIDS[p] && p !== 0x01 && p !== 0x41);
    const head = ['data_hora', 'bateria_V', 'consumo_L_h', ...cols.map(p => OBD.unitOf(p) ? `${OBD.nameOf(p)} (${OBD.unitOf(p)})` : OBD.nameOf(p))];
    S.rec = { cols, lines: [head.join(';')], last: 0, start: new Date() };
    $('btn-rec').classList.add('on'); $('btn-rec').textContent = '■ REC';
    toast('Gravando trajeto…');
  };
  const cell = v => (v == null ? '' : typeof v === 'number' ? String(Math.round(v * 1000) / 1000).replace('.', ',') : `"${String(v).replace(/"/g, "'")}"`);
  const local = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString();
  function writeRecord() {
    S.rec.last = Date.now();
    S.rec.lines.push([local(new Date()).slice(0, 19).replace('T', ' '), cell(battery()[0]), cell(fuelRate()), ...S.rec.cols.map(p => cell(S.values[p]))].join(';'));
  }
  function stopRecord() {
    const rec = S.rec; S.rec = null;
    $('btn-rec').classList.remove('on'); $('btn-rec').textContent = '● REC';
    const name = `trajeto_${local(rec.start).slice(0, 19).replace(/[T:]/g, '-')}.csv`;
    Files.save(name, rec.lines.join('\n'), 'text/csv').then(where => {
      if (where) dialog('Trajeto salvo', `${rec.lines.length - 1} linha(s) gravadas.\n\nArquivo: ${where}`, [['OK', ''], ['Compartilhar', 'accent']]).then(i => { if (i === 1) Files.share(name, rec.lines.join('\n'), 'text/csv'); });
      else dialog('Erro', 'Não foi possível salvar o arquivo.');
    });
  }

  buildDash();
  window.App = { S, M, num, has, battery, batteryState, fuelRate, airFlow, consumptionNow, engineRunning, job, buildDash, setPriorities,
    connect, calibrateBattery, FUELS, available, get vcal() { return vcal; } };
  window.PainelOBD = { S, connect };
  if (/demo/.test(location.hash)) setTimeout(() => connect('demo'), 300);
})();
