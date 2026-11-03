/* Painel OBD – viagens, garagem (abastecimentos e manutenção), alertas, desempenho, HUD,
   relatório para o mecânico, personalização, ajustes, exportação e backup. */
(function () {
  const { $, fmt, fmtInt, money, esc, parseNum, today, dateBR, dur, store, settings, saveSettings, DEFAULTS,
    on, toast, dialog, form, show, onBack, android, beep } = U;
  const ts2date = t => { const d = new Date(t); return new Date(d - d.getTimezoneOffset() * 60000).toISOString(); };
  const dmy = t => dateBR(ts2date(t));
  const hm = t => ts2date(t).slice(11, 16);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const csvCell = v => (v == null || v === '' ? '' : typeof v === 'number' ? String(Math.round(v * 1000) / 1000).replace('.', ',') : `"${String(v).replace(/"/g, '""')}"`);
  const csv = (head, rows) => [head.join(';')].concat(rows.map(r => r.map(csvCell).join(';'))).join('\n');
  const stamp = () => ts2date(Date.now()).slice(0, 16).replace(/[T:]/g, '-');

  /* ============================== HODÔMETRO ============================== */
  const Odo = {
    get data() { return store.json('odo', { base: null, added: 0 }); },
    value() { const o = Odo.data; const cur = Trips.current(); return o.base == null ? null : o.base + o.added + (cur ? cur.km : 0); },
    set(km) { store.put('odo', { base: km, added: 0, at: Date.now() }); },
    add(km) { const o = Odo.data; o.added += km; store.put('odo', o); }
  };

  /* ============================== VIAGENS ============================== */
  const Trips = (() => {
    let cur = null, lastTs = null, offSince = null, lastSave = 0;
    const list = () => store.json('trips', []);
    function finish() {
      if (!cur) return;
      const t = cur; cur = null; lastTs = null; offSince = null;
      store.put('tripCur', null);
      if (t.km >= 0.1 || t.moving + t.idle >= 120) {
        t.end = t.last || Date.now();
        const l = list(); l.unshift(t); store.put('trips', l.slice(0, 500));
        Odo.add(t.km);
      }
      if (U.pane === 'trips-pane') render();
      if (U.pane === 'garage-pane' && window.Garage) window.Garage.render();
    }
    // viagem que ficou aberta (app fechado no meio): finaliza agora
    const pending = store.json('tripCur', null);
    if (pending) { cur = pending; finish(); }

    on('data', (batch, ts) => {
      if (!(batch[0x0C] || batch[0x0D])) return;
      const rpm = App.num(0x0C), spd = App.num(0x0D) || 0;
      const running = (rpm || 0) > 300 || spd > 0;
      if (!cur) {
        if (!running) return;
        cur = { id: uid(), start: Date.now(), last: Date.now(), km: 0, fuel: 0, fuelKnown: false, moving: 0, idle: 0, maxSpd: 0, maxRpm: 0, maxEct: null, demo: App.S.demo };
        lastTs = ts;
      }
      const dt = lastTs ? Math.min(5, Math.max(0, (ts - lastTs) / 1000)) : 0; lastTs = ts;
      if (running) offSince = null;
      else { offSince = offSince || ts; if (ts - offSince > 90000) { finish(); return; } }
      cur.km += spd * dt / 3600;
      const lph = App.fuelRate();
      if (lph != null) { cur.fuel += lph * dt / 3600; cur.fuelKnown = true; }
      if (spd > 2) cur.moving += dt; else if (running) cur.idle += dt;
      cur.maxSpd = Math.max(cur.maxSpd, spd); cur.maxRpm = Math.max(cur.maxRpm, rpm || 0);
      const ect = App.num(0x05, 0x67); if (ect != null) cur.maxEct = Math.max(cur.maxEct == null ? -99 : cur.maxEct, ect);
      cur.last = Date.now();
      if (Date.now() - lastSave > 10000) { lastSave = Date.now(); store.put('tripCur', cur); }
      if (U.pane === 'trips-pane') { renderLive(); if (Date.now() - (render.t || 0) > 5000) { render.t = Date.now(); render(); } }
    });
    on('disconnected', () => finish());

    const avg = t => (t.fuelKnown && t.fuel > 0.02 && t.km > 0.2 ? t.km / t.fuel : null);
    const avgSpd = t => (t.moving + t.idle > 30 ? t.km / ((t.moving + t.idle) / 3600) : null);
    function tripStats(t) {
      return `<div class="stats">
        <div><b class="num">${fmt(t.km, 1)}</b><span>km</span></div>
        <div><b class="num">${dur(t.moving + t.idle)}</b><span>duração</span></div>
        <div><b class="num">${fmt(avg(t), 1)}</b><span>km/L</span></div>
        <div><b class="num">${t.fuelKnown ? fmt(t.fuel, 2) : '—'}</b><span>litros</span></div>
        <div><b class="num">${fmt(avgSpd(t), 0)}</b><span>km/h média</span></div>
        <div><b class="num">${fmt(t.maxSpd, 0)}</b><span>km/h máx.</span></div>
      </div>`;
    }
    function renderLive() {
      $('trip-live').innerHTML = cur
        ? `<div class="card-h"><b>Viagem em andamento</b><span class="pill live">● AO VIVO</span></div>${tripStats(cur)}<p class="hint" style="margin:6px 14px 12px">Começou às ${hm(cur.start)} · parado ${dur(cur.idle)} · rotação máx. ${fmtInt(cur.maxRpm)} rpm${cur.maxEct != null ? ` · motor até ${cur.maxEct} °C` : ''}</p>`
        : `<div class="empty">Nenhuma viagem em andamento.<br><small>Ela começa sozinha quando o app estiver conectado e o motor ligado.</small></div>`;
    }
    function render() {
      renderLive();
      const l = list();
      const now = new Date(), month = (cur ? [cur] : []).concat(l).filter(t => { const d = new Date(t.start); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); });
      const km = month.reduce((s, t) => s + t.km, 0), fuelTrips = month.filter(t => t.fuelKnown);
      const fkm = fuelTrips.reduce((s, t) => s + t.km, 0), fl = fuelTrips.reduce((s, t) => s + t.fuel, 0);
      const price = window.Garage ? window.Garage.lastPrice() : null;
      $('trip-month').innerHTML = `<div class="stats">
        <div><b class="num">${fmt(km, 0)}</b><span>km no mês</span></div>
        <div><b class="num">${month.length}</b><span>viagens</span></div>
        <div><b class="num">${fl > 0.05 ? fmt(fkm / fl, 1) : '—'}</b><span>km/L médio</span></div>
        <div><b class="num">${fl > 0 ? fmt(fl, 1) : '—'}</b><span>litros (est.)</span></div>
        <div><b class="num">${price && fl > 0 ? money(fl * price) : '—'}</b><span>gasto estimado</span></div>
        <div><b class="num">${Odo.value() != null ? fmtInt(Odo.value()) : '—'}</b><span>hodômetro</span></div>
      </div>`;
      $('trip-list').innerHTML = l.length ? l.slice(0, 100).map(t => `
        <div class="row trip" data-id="${t.id}">
          <div class="n"><b>${dmy(t.start)} · ${hm(t.start)}–${hm(t.end || t.last)}${t.demo ? ' <span class="pill nsup">DEMO</span>' : ''}</b>
            <small>${dur(t.moving + t.idle)} · máx. ${fmt(t.maxSpd, 0)} km/h${t.fuelKnown ? ' · ' + fmt(t.fuel, 2) + ' L' : ''}</small></div>
          <div class="val"><b class="num">${fmt(t.km, 1)}</b><span class="u">km</span><small class="num">${avg(t) ? fmt(avg(t), 1) + ' km/L' : ''}</small></div>
        </div>`).join('') : '<div class="empty">As viagens aparecem aqui automaticamente.</div>';
    }
    $('trip-list').addEventListener('click', async e => {
      const r = e.target.closest('.trip'); if (!r) return;
      const l = list(), t = l.find(x => x.id === r.dataset.id); if (!t) return;
      const i = await dialog(`Viagem de ${dmy(t.start)}`,
        `Das ${hm(t.start)} às ${hm(t.end || t.last)}\nDistância: ${fmt(t.km, 2)} km\nDuração: ${dur(t.moving + t.idle)} (parado ${dur(t.idle)})\n` +
        `Combustível: ${t.fuelKnown ? fmt(t.fuel, 2) + ' L' : 'não calculado'}\nMédia: ${avg(t) ? fmt(avg(t), 1) + ' km/L' : '—'}\n` +
        `Velocidade média: ${fmt(avgSpd(t), 0)} km/h · máxima: ${fmt(t.maxSpd, 0)} km/h\nRotação máxima: ${fmtInt(t.maxRpm)} rpm\nTemperatura máxima do motor: ${t.maxEct != null ? t.maxEct + ' °C' : '—'}`,
        [['Excluir', 'danger'], ['Fechar', 'accent']]);
      if (i === 0 && (await dialog('Excluir viagem?', 'Os km dela continuam no hodômetro do app.', [['Cancelar', ''], ['Excluir', 'danger']])) === 1) {
        store.put('trips', l.filter(x => x.id !== t.id)); render();
      }
    });
    function toCsv() {
      return csv(['Data', 'Início', 'Fim', 'Distância (km)', 'Duração (min)', 'Tempo parado (min)', 'Combustível (L)', 'Média (km/L)',
        'Vel. média (km/h)', 'Vel. máxima (km/h)', 'Rotação máxima (rpm)', 'Temp. máxima motor (°C)'],
      list().map(t => [dmy(t.start), hm(t.start), hm(t.end || t.last), t.km, (t.moving + t.idle) / 60, t.idle / 60,
        t.fuelKnown ? t.fuel : '', avg(t), avgSpd(t), t.maxSpd, t.maxRpm, t.maxEct]));
    }
    $('btn-trips-csv').onclick = () => exportOne('viagens', toCsv());
    on('pane', id => { if (id === 'trips-pane') render(); });
    return { current: () => cur, render, list, toCsv, finish };
  })();
  window.Trips = Trips;

  /* ============================== GARAGEM ============================== */
  const PRESETS = [
    ['Troca de óleo do motor', 5000, 6], ['Filtro de óleo', 5000, 6], ['Filtro de ar do motor', 10000, 12],
    ['Filtro de combustível', 20000, 12], ['Filtro do ar-condicionado', 10000, 12], ['Velas de ignição', 30000, 0],
    ['Fluido de freio', 0, 24], ['Líquido de arrefecimento', 40000, 24], ['Alinhamento e balanceamento', 10000, 0],
    ['Pastilhas de freio (verificar)', 20000, 0], ['Correia dentada (confira o manual)', 50000, 48], ['Pneus (rodízio)', 10000, 0]
  ];
  const Garage = (() => {
    const fuels = () => store.json('fuelLogs', []).sort((a, b) => a.km - b.km || a.date.localeCompare(b.date));
    const items = () => store.json('maint', []);
    const lastPrice = () => { const f = fuels(); return f.length ? f[f.length - 1].price : null; };

    // consumo real: entre dois tanques cheios
    function fuelStats() {
      const f = fuels(), out = {};
      let prevFull = null, litersSince = 0, costSince = 0;
      for (const e of f) {
        litersSince += e.liters; costSince += e.total || 0;
        if (e.full) {
          if (prevFull && e.km > prevFull.km) out[e.id] = { kml: (e.km - prevFull.km) / litersSince, rkm: costSince / (e.km - prevFull.km), from: prevFull, to: e, liters: litersSince };
          prevFull = e; litersSince = 0; costSince = 0;
        }
      }
      return out;
    }
    function maintStatus(it) {
      const odo = Odo.value();
      let kmLeft = null, daysLeft = null, frac = 0;
      if (it.everyKm && it.lastKm != null && odo != null) { kmLeft = it.lastKm + it.everyKm - odo; frac = Math.max(frac, 1 - kmLeft / it.everyKm); }
      if (it.everyMonths && it.lastDate) {
        const due = new Date(it.lastDate); due.setMonth(due.getMonth() + it.everyMonths);
        daysLeft = Math.round((due - new Date()) / 86400000);
        frac = Math.max(frac, 1 - daysLeft / (it.everyMonths * 30.4));
      }
      const over = (kmLeft != null && kmLeft <= 0) || (daysLeft != null && daysLeft <= 0);
      const soon = !over && ((kmLeft != null && kmLeft <= Math.max(500, it.everyKm * 0.1)) || (daysLeft != null && daysLeft <= 30));
      return { kmLeft, daysLeft, frac: Math.min(1, Math.max(0, frac)), state: over ? 'over' : soon ? 'soon' : 'ok' };
    }
    const leftText = s => {
      const p = [];
      if (s.kmLeft != null) p.push(s.kmLeft <= 0 ? `venceu há ${fmtInt(-s.kmLeft)} km` : `faltam ${fmtInt(s.kmLeft)} km`);
      if (s.daysLeft != null) p.push(s.daysLeft <= 0 ? `venceu há ${-s.daysLeft} dias` : s.daysLeft > 60 ? `${Math.round(s.daysLeft / 30.4)} meses` : `${s.daysLeft} dias`);
      return p.join(' · ') || 'defina a última troca';
    };

    function render() {
      const odo = Odo.value();
      $('odo-val').textContent = odo != null ? fmtInt(odo) + ' km' : 'Não definido';
      $('odo-hint').textContent = odo != null ? 'O app soma sozinho os km de cada viagem.' : 'Digite o km do painel do carro uma vez; depois o app soma sozinho os km rodados.';
      // manutenção
      const its = items();
      $('maint-list').innerHTML = its.length ? its.map(it => {
        const s = maintStatus(it);
        return `<div class="maint ${s.state}" data-id="${it.id}">
          <div class="mh"><b>${esc(it.name)}</b><span class="pill ${s.state === 'over' ? 'bad' : s.state === 'soon' ? 'inc' : 'ok'}">${s.state === 'over' ? 'VENCIDA' : s.state === 'soon' ? 'EM BREVE' : 'EM DIA'}</span></div>
          <div class="bar"><i style="width:${Math.round(s.frac * 100)}%"></i></div>
          <div class="mf"><small>${leftText(s)}${it.lastKm != null || it.lastDate ? ` · última: ${it.lastKm != null ? fmtInt(it.lastKm) + ' km' : ''}${it.lastDate ? ' em ' + dateBR(it.lastDate) : ''}` : ''}</small>
          <button class="btn mini" data-done="${it.id}">Feito hoje</button></div></div>`;
      }).join('') : '<div class="empty">Nenhum item. Toque em “Adicionar” para registrar troca de óleo, filtros, etc.</div>';
      // abastecimentos
      const f = fuels(), st = fuelStats(), pairs = Object.values(st);
      const totL = pairs.reduce((s, p) => s + p.liters, 0), totKm = pairs.reduce((s, p) => s + (p.to.km - p.from.km), 0);
      const now = new Date(), monthCost = f.filter(e => { const d = new Date(e.date); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); }).reduce((s, e) => s + (e.total || 0), 0);
      const costKm = pairs.length ? pairs.reduce((s, p) => s + p.rkm * (p.to.km - p.from.km), 0) / totKm : null;
      $('fuel-sum').innerHTML = `<div class="stats">
        <div><b class="num">${totL > 0 ? fmt(totKm / totL, 1) : '—'}</b><span>km/L real</span></div>
        <div><b class="num">${costKm != null ? money(costKm) : '—'}</b><span>por km</span></div>
        <div><b class="num">${money(monthCost)}</b><span>gasto no mês</span></div>
      </div>`;
      $('fuel-list').innerHTML = f.length ? f.slice().reverse().slice(0, 100).map(e => `
        <div class="row fuel" data-id="${e.id}"><div class="n"><b>${dateBR(e.date)} · ${fmtInt(e.km)} km</b>
          <small>${fmt(e.liters, 2)} L · ${money(e.price)}/L · ${esc((App.FUELS[e.fuel] || {}).label || e.fuel)}${e.full ? ' · cheio' : ' · parcial'}</small></div>
          <div class="val"><b class="num">${money(e.total)}</b><small class="num">${st[e.id] ? fmt(st[e.id].kml, 1) + ' km/L' : ''}</small></div></div>`).join('')
        : '<div class="empty">Registre os abastecimentos para saber o consumo real e o custo por km.<br><small>Para calcular o consumo, encha o tanque e marque “Tanque cheio”.</small></div>';
      renderCalib(st);
    }

    // comparar consumo real (tanque cheio a tanque cheio) com o calculado pelo app nas viagens do mesmo período
    function renderCalib(st) {
      const pairs = Object.values(st); const box = $('calib-box');
      if (!pairs.length) { box.innerHTML = ''; return; }
      const p = pairs[pairs.length - 1];
      const t0 = new Date(p.from.date).getTime(), t1 = new Date(p.to.date).getTime() + 86400000;
      const tr = Trips.list().filter(t => t.fuelKnown && !t.demo && t.start >= t0 && t.start < t1);
      const km = tr.reduce((s, t) => s + t.km, 0), fl = tr.reduce((s, t) => s + t.fuel, 0);
      if (km < 30 || fl <= 0) { box.innerHTML = ''; return; }
      const appKml = km / fl, diff = Math.abs(appKml - p.kml) / p.kml;
      box.innerHTML = `<div class="banner ${diff > 0.08 ? 'warn' : 'ok'}" style="font-weight:600">No último tanque o consumo real foi <b>${fmt(p.kml, 1)} km/L</b> e o app calculou <b>${fmt(appKml, 1)} km/L</b>.
        ${diff > 0.08 ? '<br><button class="btn accent mini" id="btn-calib" style="margin-top:8px">Ajustar o cálculo do app</button>' : '<br>O cálculo do app está bem ajustado.'}</div>`;
      const b = $('btn-calib');
      if (b) b.onclick = () => {
        settings.consFactor = Math.round(settings.consFactor * appKml / p.kml * 1000) / 1000;
        saveSettings(); toast(`Consumo ajustado (fator ${fmt(settings.consFactor * 100, 0)}%)`); render();
      };
    }

    $('btn-odo').onclick = async () => {
      const v = await form('Hodômetro', [{ key: 'km', label: 'Km atual no painel do carro', type: 'number', value: Odo.value() != null ? Math.round(Odo.value()) : '', suffix: 'km', required: true }]);
      if (v && v.km >= 0) { Odo.set(v.km); toast('Hodômetro atualizado'); render(); }
    };

    async function editFuel(e) {
      const isNew = !e; e = e || { id: uid(), date: today(), km: Odo.value() != null ? Math.round(Odo.value()) : null, full: true, fuel: settings.fuel === 'flex' ? 'gasolina' : settings.fuel };
      const v = await form(isNew ? 'Registrar abastecimento' : 'Editar abastecimento', [
        { key: 'date', label: 'Data', type: 'date', value: e.date },
        { key: 'km', label: 'Hodômetro (km do painel)', type: 'number', value: e.km, suffix: 'km', required: true },
        { key: 'liters', label: 'Litros', type: 'number', value: e.liters, suffix: 'L', required: true },
        { key: 'total', label: 'Valor pago', type: 'number', value: e.total, suffix: 'R$', required: true },
        { key: 'fuel', label: 'Combustível', type: 'select', value: e.fuel, options: Object.entries(App.FUELS).filter(([k]) => k !== 'flex').map(([k, f]) => [k, f.label]) },
        { key: 'full', label: 'Tanque cheio', type: 'toggle', value: e.full, hint: 'Marque quando encher o tanque: é assim que o app calcula o consumo real.' }
      ], { extra: isNew ? [] : [['Excluir', 'danger', 'del']] });
      if (!v) return;
      let l = store.json('fuelLogs', []).filter(x => x.id !== e.id);
      if (v._action !== 'del') {
        const n = { id: e.id, date: v.date || today(), km: v.km, liters: v.liters, total: v.total, price: v.liters ? v.total / v.liters : null, fuel: v.fuel, full: v.full };
        l.push(n);
        if (Odo.value() == null || n.km > Odo.value()) Odo.set(n.km);
      }
      store.put('fuelLogs', l); render();
    }
    $('btn-fuel-add').onclick = () => editFuel();
    $('fuel-list').addEventListener('click', e => { const r = e.target.closest('.fuel'); if (r) editFuel(store.json('fuelLogs', []).find(x => x.id === r.dataset.id)); });

    async function editItem(it) {
      const isNew = !it;
      if (isNew) {
        const p = await form('Adicionar manutenção', [{ key: 'preset', label: 'O que vai acompanhar?', type: 'select', value: 0, options: PRESETS.map((p, i) => [i, p[0]]).concat([['x', 'Outro (digitar)']]) }], { submit: 'Continuar' });
        if (!p) return;
        const pr = PRESETS[p.preset] || ['', 0, 0];
        it = { id: uid(), name: pr[0], everyKm: pr[1] || null, everyMonths: pr[2] || null, lastKm: Odo.value() != null ? Math.round(Odo.value()) : null, lastDate: today() };
      }
      const v = await form(isNew ? 'Nova manutenção' : 'Editar manutenção', [
        { key: 'name', label: 'Item', type: 'text', value: it.name, required: true },
        { key: 'everyKm', label: 'Repetir a cada', type: 'number', value: it.everyKm, suffix: 'km', hint: 'Deixe vazio se for só por tempo.' },
        { key: 'everyMonths', label: 'ou a cada', type: 'number', value: it.everyMonths, suffix: 'meses', hint: 'Deixe vazio se for só por km. Vale o que vencer primeiro.' },
        { key: 'lastKm', label: 'Última vez feita com', type: 'number', value: it.lastKm, suffix: 'km' },
        { key: 'lastDate', label: 'Data da última vez', type: 'date', value: it.lastDate }
      ], { extra: isNew ? [] : [['Excluir', 'danger', 'del']] });
      if (!v) return;
      let l = items().filter(x => x.id !== it.id);
      if (v._action !== 'del') l.push({ id: it.id, name: v.name, everyKm: v.everyKm || null, everyMonths: v.everyMonths || null, lastKm: v.lastKm, lastDate: v.lastDate || null });
      store.put('maint', l); render();
    }
    $('btn-maint-add').onclick = () => editItem();
    $('maint-list').addEventListener('click', async e => {
      const d = e.target.closest('[data-done]');
      if (d) {
        const l = items(), it = l.find(x => x.id === d.dataset.done);
        const odo = Odo.value();
        if ((await dialog(`${it.name}: feito hoje?`, `Registra como feito hoje${odo != null ? ` com ${fmtInt(odo)} km` : ''}. A próxima será calculada a partir daí.`, [['Cancelar', ''], ['Confirmar', 'accent']])) === 1) {
          it.lastDate = today(); if (odo != null) it.lastKm = Math.round(odo);
          store.put('maint', l); render(); toast('Registrado');
        }
        return;
      }
      const r = e.target.closest('.maint'); if (r) editItem(items().find(x => x.id === r.dataset.id));
    });

    function dueList() { return items().map(it => [it, maintStatus(it)]).filter(([, s]) => s.state !== 'ok'); }
    function fuelCsv() {
      const st = fuelStats();
      return csv(['Data', 'Hodômetro (km)', 'Litros', 'Valor pago (R$)', 'Preço por litro (R$)', 'Combustível', 'Tanque cheio', 'Consumo real (km/L)', 'Custo por km (R$)'],
        fuels().map(e => [dateBR(e.date), e.km, e.liters, e.total, e.price, (App.FUELS[e.fuel] || {}).label || e.fuel, e.full ? 'Sim' : 'Não', st[e.id] ? st[e.id].kml : '', st[e.id] ? st[e.id].rkm : '']));
    }
    function maintCsv() {
      return csv(['Item', 'A cada (km)', 'A cada (meses)', 'Última vez (km)', 'Última vez (data)', 'Situação', 'Faltam (km)', 'Faltam (dias)'],
        items().map(it => { const s = maintStatus(it); return [it.name, it.everyKm, it.everyMonths, it.lastKm, dateBR(it.lastDate), { ok: 'Em dia', soon: 'Em breve', over: 'Vencida' }[s.state], s.kmLeft, s.daysLeft]; }));
    }
    $('btn-fuel-csv').onclick = () => exportOne('abastecimentos', fuelCsv());
    $('btn-maint-csv').onclick = () => exportOne('manutencoes', maintCsv());
    on('pane', id => { if (id === 'garage-pane') render(); });
    return { render, lastPrice, dueList, fuelCsv, maintCsv, maintStatus, leftText };
  })();
  window.Garage = Garage;

  /* ============================== ALERTAS ============================== */
  const Alerts = (() => {
    const last = {};
    let batBadSince = null, milBase = null, countBase = null;
    function alert(key, msg, level = 'warn', speech) {
      const a = settings.alerts;
      if (Date.now() - (last[key] || 0) < 90000) return;
      last[key] = Date.now();
      const bar = $('alert-bar');
      bar.textContent = msg; bar.className = 'show ' + level;
      clearTimeout(alert.t); alert.t = setTimeout(() => (bar.className = ''), 7000);
      if (a.vib) android.vibrate(level === 'danger' ? [0, 450, 150, 450, 150, 450] : [0, 300, 150, 300]);
      if (a.sound) beep(level);
      if (a.voice) setTimeout(() => android.speak(speech || msg), a.sound ? 700 : 0);
    }
    $('alert-bar').onclick = () => ($('alert-bar').className = '');
    on('connected', () => {
      milBase = null; countBase = null; batBadSince = null;
      if (settings.alerts.maint) setTimeout(checkMaint, 4000);
    });
    on('data', (batch, ts) => {
      const a = settings.alerts;
      const ect = App.num(0x05, 0x67);
      if (ect != null && a.temp && ect >= a.temp) alert('temp', `Temperatura do motor alta: ${ect} °C`, 'danger', `Atenção: temperatura do motor alta, ${ect} graus`);
      const [v] = App.battery();
      if (a.battery && v != null) {
        const st = App.batteryState(v);
        if (st === 'danger') {
          batBadSince = batBadSince || ts;
          if (ts - batBadSince > 15000) {
            const running = App.engineRunning();
            alert('bat', running ? `Alternador/bateria: ${fmt(v, 1)} V com o motor ligado` : `Bateria fraca: ${fmt(v, 1)} V`, 'danger',
              running ? `Atenção: tensão de ${fmt(v, 1)} volts com o motor ligado. Verifique o alternador.` : `Atenção: bateria fraca, ${fmt(v, 1)} volts`);
          }
        } else batBadSince = null;
      }
      const rpm = App.num(0x0C), spd = App.num(0x0D);
      if (a.rpm > 0 && rpm != null && rpm >= a.rpm) alert('rpm', `Rotação alta: ${fmtInt(rpm)} rpm`, 'warn', 'Rotação alta');
      if (a.speed > 0 && spd != null && spd >= a.speed) alert('spd', `Velocidade acima de ${a.speed} km/h`, 'warn', `Velocidade acima de ${a.speed}`);
      if (batch[0x01] && a.dtc) {
        const raw = App.S.raw[0x01]; const b0 = raw ? parseInt(raw.split(' ')[0], 16) : 0;
        const mil = !!(b0 & 0x80), count = b0 & 0x7F;
        if (milBase === null) { milBase = mil; countBase = count; }
        else if ((mil && !milBase) || count > countBase) {
          milBase = mil; countBase = count;
          alert('dtc', 'Nova falha detectada no motor', 'danger', 'Atenção: nova falha detectada no motor');
          if (App.S.engine) App.S.engine.submit('dtcquiet');
        } else { milBase = mil; countBase = count; }
      }
    });
    function checkMaint() {
      const due = Garage.dueList(); if (!due.length) return;
      const day = today(); if (store.get('maintAlertDay') === day) return;
      store.set('maintAlertDay', day);
      const [it, s] = due.sort((x, y) => (x[1].state === 'over' ? -1 : 1))[0];
      alert('maint', `Manutenção: ${it.name} – ${Garage.leftText(s)}${due.length > 1 ? ` (+${due.length - 1})` : ''}`, 'warn',
        `Lembrete de manutenção: ${it.name}, ${Garage.leftText(s).replace('km', 'quilômetros')}`);
    }
    return { alert, test: () => { last.test = 0; alert('test', 'Teste de alerta: tudo funcionando', 'warn', 'Teste de alerta do Painel OBD'); } };
  })();

  /* ============================== DESEMPENHO ============================== */
  const Perf = (() => {
    const TESTS = { '0-60': [0, 60], '0-100': [0, 100], '60-100': [60, 100], '80-120': [80, 120] };
    let type = '0-100', state = 'idle', prev = null, t0 = null, lastZero = null, raf = null, rates = [];
    const results = () => store.json('perf', []);
    function setFocus(onf) { if (App.S.engine) App.S.engine.focus = onf ? [0x0D] : null; }
    function msg(t, cls = '') { $('perf-msg').textContent = t; $('perf-msg').className = 'perf-msg ' + cls; }
    function arm() {
      if (!App.S.connected) { toast('Conecte ao carro primeiro'); return; }
      state = 'armed'; prev = null; t0 = null; rates = []; setFocus(true);
      $('perf-go').textContent = 'Cancelar'; $('perf-time').textContent = '0,00';
      const [a] = TESTS[type];
      msg(a === 0 ? 'Pare o carro. O tempo começa quando ele andar.' : `Fique abaixo de ${a} km/h e acelere fundo. O tempo começa ao passar de ${a}.`);
    }
    function cancel(text) {
      state = 'idle'; setFocus(false); cancelAnimationFrame(raf);
      $('perf-go').textContent = 'Preparar'; if (text) msg(text);
    }
    function tick() { if (state === 'run') { $('perf-time').textContent = fmt((performance.now() - t0.perf) / 1000, 2); raf = requestAnimationFrame(tick); } }
    on('data', (batch, ts) => {
      if (!(0x0D in batch)) return;
      const v = batch[0x0D][1];
      if (U.pane === 'perf-pane') $('perf-speed').textContent = v;
      if (state === 'idle' || state === 'done') return;
      if (prev) rates.push(ts - prev.ts);
      const [a, b] = TESTS[type];
      if (state === 'armed') {
        if (a === 0) {
          if (v === 0) { lastZero = ts; msg('Pronto! Pode acelerar.', 'ok'); }
          else if (prev && prev.v === 0 && lastZero) {          // saiu do zero entre as duas leituras
            const start = (lastZero + ts) / 2;
            t0 = { ts: start, perf: performance.now() - (ts - start) }; state = 'run'; msg('Medindo…', 'run'); tick();
          } else msg('Pare o carro para começar.');
        } else {
          if (v < a - 3) msg('Pronto! Acelere fundo.', 'ok');
          else if (prev && prev.v < a && v >= a) {
            const start = prev.ts + (a - prev.v) / (v - prev.v) * (ts - prev.ts);
            t0 = { ts: start, perf: performance.now() - (ts - start) }; state = 'run'; msg('Medindo…', 'run'); tick();
          } else if (v >= a) msg(`Desacelere para menos de ${a} km/h.`);
        }
      } else if (state === 'run') {
        if (v >= b && prev) {
          const end = prev.v >= b ? ts : prev.ts + (b - prev.v) / (v - prev.v) * (ts - prev.ts);
          const time = (end - t0.ts) / 1000;
          const hz = rates.length ? 1000 / (rates.reduce((s, x) => s + x, 0) / rates.length) : 0;
          state = 'done'; setFocus(false); cancelAnimationFrame(raf);
          $('perf-time').textContent = fmt(time, 2);
          const l = results(); const best = !l.some(r => r.type === type && r.time <= time);
          l.unshift({ id: uid(), type, time, at: Date.now(), hz, demo: App.S.demo }); store.put('perf', l.slice(0, 100));
          msg(`${type} km/h em ${fmt(time, 2)} s${best ? ' · novo recorde!' : ''} (precisão ±${fmt(hz ? 0.5 / hz : 0, 2)} s)`, 'ok');
          $('perf-go').textContent = 'Preparar'; render();
          if (settings.alerts.voice) android.speak(`${type.replace('-', ' a ')}: ${fmt(time, 1)} segundos`);
        } else if (v < (prev ? prev.v : v) - 8 || (ts - t0.ts) > 90000) cancel('Teste cancelado (o carro desacelerou). Toque em Preparar para tentar de novo.');
      }
      prev = { ts, v };
    });
    function render() {
      document.querySelectorAll('#perf-types button').forEach(b => b.classList.toggle('on', b.dataset.t === type));
      const l = results();
      $('perf-list').innerHTML = l.length ? l.slice(0, 30).map(r => {
        const best = Math.min(...l.filter(x => x.type === r.type).map(x => x.time)) === r.time;
        return `<div class="row"><div class="n"><b>${r.type} km/h${best ? ' <span class="pill ok">MELHOR</span>' : ''}${r.demo ? ' <span class="pill nsup">DEMO</span>' : ''}</b><small>${dmy(r.at)} ${hm(r.at)} · ${fmt(r.hz, 1)} leituras/s</small></div><div class="val"><b class="num">${fmt(r.time, 2)}</b><span class="u">s</span></div></div>`;
      }).join('') : '<div class="empty">Nenhum teste ainda.</div>';
    }
    $('perf-types').onclick = e => { const b = e.target.closest('button'); if (!b) return; if (state === 'run' || state === 'armed') cancel(); type = b.dataset.t; render(); msg('Toque em Preparar.'); };
    $('perf-go').onclick = () => (state === 'armed' || state === 'run' ? cancel('Cancelado.') : arm());
    $('perf-clear').onclick = async () => { if ((await dialog('Apagar resultados?', 'Todos os tempos salvos serão apagados.', [['Cancelar', ''], ['Apagar', 'danger']])) === 1) { store.put('perf', []); render(); } };
    on('pane', id => { if (id === 'perf-pane') render(); else if (state === 'armed' || state === 'run') cancel('Teste cancelado ao sair da tela.'); });
    on('disconnected', () => { if (state !== 'idle') cancel('Desconectado.'); });
    return { results };
  })();

  /* ============================== MODO HUD ============================== */
  const Hud = (() => {
    let open = false, ctrlT;
    function apply() {
      $('hud').classList.toggle('mirror', !!settings.hud.mirror);
      $('hud-unit').textContent = settings.hud.main === 'rpm' ? 'rpm' : 'km/h';
    }
    function enter() { open = true; apply(); $('hud').classList.add('show'); android.brightness(true); update(); showCtrl(); }
    function exit() { open = false; $('hud').classList.remove('show'); android.brightness(false); }
    function showCtrl() { $('hud').classList.add('ctrl'); clearTimeout(ctrlT); ctrlT = setTimeout(() => $('hud').classList.remove('ctrl'), 4000); }
    function update() {
      if (!open) return;
      const rpm = App.num(0x0C), spd = App.num(0x0D);
      const main = settings.hud.main === 'rpm' ? rpm : spd;
      $('hud-main').textContent = main == null ? '--' : Math.round(main);
      $('hud-bar').style.width = Math.min(100, (rpm || 0) / 70) + '%';
      $('hud-bar').className = (rpm || 0) > 6000 ? 'red' : '';
      const ect = App.num(0x05, 0x67), c = App.consumptionNow();
      $('hud-sub').innerHTML = `<span>${ect != null ? ect + '°C' : '--'}</span><span>${c ? fmt(c.v, 1) + ' ' + c.unit : '--'}</span><span>${settings.hud.main === 'rpm' ? (spd != null ? spd + ' km/h' : '--') : (rpm != null ? fmtInt(rpm) + ' rpm' : '--')}</span>`;
    }
    on('data', update);
    $('hud').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) { showCtrl(); return; }
      if (b.dataset.h === 'mirror') settings.hud.mirror = !settings.hud.mirror;
      if (b.dataset.h === 'main') settings.hud.main = settings.hud.main === 'rpm' ? 'speed' : 'rpm';
      if (b.dataset.h === 'exit') { exit(); return; }
      saveSettings(); apply(); update(); showCtrl();
    });
    onBack(() => { if (open) { exit(); return true; } return false; });
    return { enter };
  })();
  $('btn-hud').onclick = () => Hud.enter();

  /* ============================== RELATÓRIO PARA O MECÂNICO ============================== */
  const Report = (() => {
    let waiting = false;
    $('btn-report').onclick = () => {
      if (App.S.connected) { waiting = true; App.job('report'); return; }
      if (App.S.lastDtc) build(App.S.lastDtc, App.S.lastFreeze || []);
      else toast('Conecte ao carro para gerar o relatório');
    };
    on('report', (res, rows) => { if (waiting) { waiting = false; build(res, rows); } });

    function build(res, rows) {
      const W = 1080, P = 56;
      const draw = (g, real) => {
        let y = 0;
        const C = { bg: '#ffffff', ink: '#14202b', mute: '#5d6b78', line: '#dfe5ea', head: '#0b1a24', acc: '#0aa5cc', red: '#d92d2d', amb: '#c97a00', grn: '#16924c' };
        const font = (s, w = 400) => (g.font = `${w} ${s}px Roboto, Arial, sans-serif`);
        const text = (t, x, yy, s, w, col, align = 'left') => { if (real) { font(s, w); g.fillStyle = col; g.textAlign = align; g.fillText(t, x, yy); } };
        const wrap = (t, x, maxW, s, w, col, lh) => {
          font(s, w); const words = String(t).split(' '); let line = '';
          for (const wd of words) {
            const test = line ? line + ' ' + wd : wd;
            if (g.measureText(test).width > maxW && line) { text(line, x, y, s, w, col); y += lh; line = wd; } else line = test;
          }
          if (line) { text(line, x, y, s, w, col); y += lh; }
        };
        const section = t => { y += 26; text(t.toUpperCase(), P, y, 24, 800, C.acc); y += 14; if (real) { g.fillStyle = C.line; g.fillRect(P, y, W - 2 * P, 2); } y += 38; };
        const kv = (k, v, col) => { text(k, P, y, 27, 400, C.mute); font(27, 700); wrapRight(v, col); };
        const wrapRight = (v, col) => { text(String(v), W - P, y, 27, 700, col || C.ink, 'right'); y += 44; };
        if (real) { g.fillStyle = C.bg; g.fillRect(0, 0, W, g.canvas.height); g.fillStyle = C.head; g.fillRect(0, 0, W, 190); }
        text('Relatório de diagnóstico', P, 92, 52, 800, '#ffffff');
        text(`${dmy(Date.now())} às ${hm(Date.now())} · Painel OBD`, P, 145, 28, 400, '#8fd8ec');
        y = 210;
        const info = App.S.info || {};
        section('Veículo');
        kv('Chassi (VIN)', info.vin || 'Não informado');
        kv('Hodômetro', Odo.value() != null ? fmtInt(Odo.value()) + ' km' : '—');
        kv('Protocolo', (info.protocol || '—').replace(' · central do motor', ''));
        if (App.S.values[0x1C]) kv('Padrão OBD', App.S.values[0x1C]);
        const [bv, bsrc] = App.battery();
        if (bv != null) kv('Bateria', `${fmt(bv, 1)} V (${bsrc})`);
        const rd = res.readiness;
        section('Luz de injeção e falhas');
        if (rd) kv('Luz de injeção', rd.mil ? 'ACESA' : 'Apagada', rd.mil ? C.red : C.grn);
        const all = [['stored', 'Armazenada', C.red], ['pending', 'Pendente', C.amb], ['permanent', 'Permanente', '#a0378c']];
        let n = 0;
        for (const [k, label, col] of all) for (const code of res[k] || []) {
          n++; y += 6;
          text(code, P, y, 34, 800, col); text(label.toUpperCase(), P + 150, y - 4, 20, 800, col);
          y += 10; const save = y; y = save + 30; wrap(DTC.describe(code), P + 150, W - 2 * P - 150, 27, 400, C.ink, 36); y += 10;
        }
        if (!n) kv('Códigos de falha', 'Nenhum', C.grn);
        if (rows && rows.length) {
          section('Congelamento de dados (momento da falha)');
          for (const r of rows) { text(r[0], P, y, 25, 400, C.mute); text(`${r[1]} ${r[2] || ''}`.trim(), W - P, y, 25, 700, C.ink, 'right'); y += 38; }
        }
        if (rd) {
          section('Prontidão dos monitores');
          for (const [name, s] of rd.monitors.filter(m => m[1] !== 'nsup')) {
            text(name, P, y, 26, 400, C.ink);
            text(s === 'ok' ? 'PRONTO' : 'INCOMPLETO', W - P, y, 24, 800, s === 'ok' ? C.grn : C.amb, 'right'); y += 40;
          }
        }
        const live = [0x0C, 0x05, 0x04, 0x0B, 0x10, 0x0F, 0x0E, 0x06, 0x07, 0x14, 0x15, 0x11, 0x5C, 0x2F].filter(p => App.S.values[p] != null);
        if (live.length) {
          section('Dados no momento do relatório');
          for (const p of live) { text(OBD.nameOf(p), P, y, 25, 400, C.mute); text(`${OBD.fmtValue(p, App.S.values[p])} ${OBD.unitOf(p)}`.trim(), W - P, y, 25, 700, C.ink, 'right'); y += 38; }
        }
        y += 30; text('Gerado pelo app Painel OBD (leitura OBD-II genérica).', P, y, 22, 400, C.mute); y += 40;
        return y;
      };
      const tmp = document.createElement('canvas').getContext('2d');
      const H = draw(tmp, false);
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      draw(cv.getContext('2d'), true);
      const url = cv.toDataURL('image/png');
      $('report-img').src = url;
      $('report-wrap').classList.add('show');
      $('report-share').onclick = () => {
        const name = `relatorio-obd-${stamp()}.png`;
        const where = android.shareImage(url, name);
        toast(where ? `Salvo em ${where}` : 'Não foi possível compartilhar');
      };
    }
    $('report-close').onclick = () => $('report-wrap').classList.remove('show');
    return { build };
  })();

  /* ============================== PERSONALIZAR PAINEL ============================== */
  function renderCustom() {
    const opts = (withEmpty, gaugeOnly) => Object.entries(App.M).filter(([, m]) => !gaugeOnly || m.g)
      .map(([k, m]) => [k, m.label + (App.S.connected && !App.available(k) ? ' (não disponível neste carro)' : '')]);
    const sel = (val, list, key, i) => `<select data-k="${key}" data-i="${i}">${list.map(([k, l]) => `<option value="${k}"${k === val ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    $('custom-small').innerHTML = settings.dash.small.map((v, i) => `<label class="field"><span>Mostrador ${i + 1}</span>${sel(v, opts(false, true), 'small', i)}</label>`).join('');
    $('custom-tiles').innerHTML = settings.dash.tiles.map((v, i) => `<label class="field"><span>Bloco ${i + 1}</span>${sel(v, [['', '(vazio)']].concat(opts(true, false)), 'tiles', i)}</label>`).join('');
  }
  $('custom-pane').addEventListener('change', e => {
    const s = e.target.closest('select[data-k]'); if (!s) return;
    settings.dash[s.dataset.k][+s.dataset.i] = s.value; saveSettings(); App.buildDash(); toast('Painel atualizado');
  });
  $('custom-reset').onclick = () => { settings.dash = JSON.parse(JSON.stringify(DEFAULTS.dash)); saveSettings(); App.buildDash(); renderCustom(); toast('Painel padrão restaurado'); };
  on('pane', id => { if (id === 'custom-pane') renderCustom(); });

  /* ============================== AJUSTES ============================== */
  function renderSettings() {
    const a = settings.alerts, f = App.FUELS;
    const num = (key, label, val, suffix, hint) => `<label class="field"><span>${label}</span><div class="inp"><input data-set="${key}" inputmode="decimal" value="${val == null ? '' : String(val).replace('.', ',')}"><em>${suffix}</em></div>${hint ? `<small>${hint}</small>` : ''}</label>`;
    const tog = (key, label, val, hint) => `<label class="field toggle"><span>${label}</span><input type="checkbox" data-set="${key}"${val ? ' checked' : ''}><i class="sw"></i>${hint ? `<small>${hint}</small>` : ''}</label>`;
    const dev = store.get('deviceName') || store.get('device');
    $('settings-body').innerHTML = `
      <div class="section-title">Motor e consumo</div>
      <div class="card form-card">
        ${num('disp', 'Cilindrada do motor', settings.disp, 'litros', 'Ex.: 1.7 → 1,7. Usada para calcular o consumo em carros sem sensor de fluxo de ar.')}
        <label class="field"><span>Combustível que costuma usar</span><select data-set="fuel">${Object.entries(f).map(([k, x]) => `<option value="${k}"${k === settings.fuel ? ' selected' : ''}>${x.label}</option>`).join('')}</select></label>
        ${num('ethanolPct', 'Etanol na gasolina', settings.ethanolPct, '%', 'No Brasil a gasolina comum tem 27%.')}
        ${num('ve', 'Eficiência volumétrica', settings.ve, '%', 'Avançado. 85% serve para a maioria dos motores aspirados.')}
        ${num('consFactor', 'Ajuste fino do consumo', Math.round(settings.consFactor * 100), '%', 'O app ajusta sozinho quando você registra dois abastecimentos com tanque cheio.')}
      </div>
      <div class="section-title">Bateria</div>
      <div class="card form-card"><div class="field"><span>Calibração da leitura do adaptador</span><small>${App.vcal !== 1 ? `Correção ativa: ${fmt((App.vcal - 1) * 100, 1)}%` : 'Sem calibração.'} Toque no bloco “Bateria” do painel com o carro conectado para calibrar com um multímetro.</small></div></div>
      <div class="section-title">Alertas</div>
      <div class="card form-card">
        ${tog('alerts.sound', 'Som', a.sound)}${tog('alerts.voice', 'Voz', a.voice, 'Fala o alerta em português.')}${tog('alerts.vib', 'Vibração', a.vib)}
        ${num('alerts.temp', 'Temperatura do motor acima de', a.temp, '°C', '0 desliga.')}
        ${tog('alerts.battery', 'Bateria fraca / alternador', a.battery)}
        ${tog('alerts.dtc', 'Nova falha no motor', a.dtc)}
        ${tog('alerts.maint', 'Lembretes de manutenção', a.maint, 'Avisa ao conectar, uma vez por dia.')}
        ${num('alerts.rpm', 'Rotação acima de', a.rpm, 'rpm', '0 desliga.')}
        ${num('alerts.speed', 'Velocidade acima de', a.speed, 'km/h', '0 desliga.')}
        <div class="field"><button class="btn" id="btn-alert-test">Testar alerta</button></div>
      </div>
      <div class="section-title">Conexão</div>
      <div class="card form-card">
        ${tog('autoConnect', 'Conectar automaticamente', settings.autoConnect, 'Ao abrir o app (e se a conexão cair), tenta o último adaptador usado.')}
        <div class="field"><span>Adaptador salvo</span><small>${dev ? esc(dev) : 'Nenhum ainda'}</small>${dev ? '<button class="btn mini" id="btn-forget">Esquecer</button>' : ''}</div>
      </div>
      <div class="section-title">Seus dados</div>
      <div class="card form-card">
        <div class="field"><span>Tudo fica salvo no próprio celular</span><small>Viagens, abastecimentos, manutenções, testes e ajustes continuam salvos mesmo fechando o app ou instalando versões novas. Só se perdem se o app for desinstalado, por isso faça backup de vez em quando.</small></div>
        <div class="actions" style="padding:4px 0 12px">
          <button class="btn accent" id="btn-backup">Fazer backup</button>
          <button class="btn" id="btn-restore">Restaurar backup</button>
          <button class="btn" id="btn-export-all">Exportar planilhas</button>
          <button class="btn danger" id="btn-wipe">Apagar tudo</button>
        </div>
        <input type="file" id="restore-file" accept=".json,application/json,text/plain,*/*" hidden>
      </div>
      <p class="hint" style="text-align:center;margin:18px 0 8px">Painel OBD · versão ${esc(android.version())}</p>`;
  }
  $('settings-pane').addEventListener('change', e => {
    const el = e.target.closest('[data-set]'); if (!el) return;
    const path = el.dataset.set.split('.');
    let v = el.type === 'checkbox' ? el.checked : el.tagName === 'SELECT' ? el.value : parseNum(el.value);
    if (v === null) v = 0;
    if (path[0] === 'consFactor') v = Math.max(0.3, Math.min(3, v / 100));
    if (path[0] === 'disp' && v > 20) v = v / 1000;  // digitou em cc
    let o = settings; for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
    o[path[path.length - 1]] = v; saveSettings();
    if (path[0] === 'disp') renderSettings();
    toast('Ajuste salvo');
  });
  $('settings-pane').addEventListener('click', async e => {
    const id = e.target.id;
    if (id === 'btn-alert-test') Alerts.test();
    if (id === 'btn-forget') { store.set('device', ''); store.set('deviceName', ''); renderSettings(); toast('Adaptador esquecido'); }
    if (id === 'btn-backup') backup();
    if (id === 'btn-restore') $('restore-file').click();
    if (id === 'btn-export-all') exportAll();
    if (id === 'btn-wipe' && (await dialog('Apagar todos os dados?', 'Viagens, abastecimentos, manutenções, testes, hodômetro e ajustes serão apagados deste celular. Faça um backup antes se quiser guardar.', [['Cancelar', ''], ['Apagar tudo', 'danger']])) === 1) {
      ['trips', 'tripCur', 'fuelLogs', 'maint', 'odo', 'perf', 'settings', 'vcal', 'maintAlertDay'].forEach(k => localStorage.removeItem(k));
      location.reload();
    }
  });
  $('settings-pane').addEventListener('change', e => { if (e.target.id === 'restore-file' && e.target.files[0]) restore(e.target.files[0]); });
  on('pane', id => { if (id === 'settings-pane') renderSettings(); });

  /* ============================== EXPORTAR E BACKUP ============================== */
  const KEYS = ['settings', 'trips', 'fuelLogs', 'maint', 'odo', 'perf', 'vcal', 'device', 'deviceName'];
  async function exportOne(name, text) {
    const file = `${name}_${stamp()}.csv`;
    const where = await Files.save(file, text, 'text/csv');
    const i = await dialog('Planilha salva', `Arquivo: ${where || file}\n\nAbre no Excel, Google Planilhas ou WPS.`, [['OK', ''], ['Compartilhar', 'accent']]);
    if (i === 1) Files.share(file, text, 'text/csv');
  }
  async function exportAll() {
    const s = stamp(), out = [];
    for (const [n, t] of [['viagens', Trips.toCsv()], ['abastecimentos', Garage.fuelCsv()], ['manutencoes', Garage.maintCsv()]]) out.push(await Files.save(`${n}_${s}.csv`, t, 'text/csv'));
    dialog('Planilhas salvas', `3 arquivos salvos:\n\n${out.join('\n')}`);
  }
  async function backup() {
    const data = {}; KEYS.forEach(k => (data[k] = localStorage.getItem(k)));
    const text = JSON.stringify({ app: 'painel-obd', version: 1, created: new Date().toISOString(), data }, null, 1);
    const file = `painel-obd-backup_${stamp()}.json`;
    const where = await Files.save(file, text, 'application/json');
    const i = await dialog('Backup salvo', `Arquivo: ${where || file}\n\nGuarde uma cópia fora do celular (Google Drive, WhatsApp, e-mail) para não perder se trocar de aparelho.`, [['OK', ''], ['Enviar para…', 'accent']]);
    if (i === 1) Files.share(file, text, 'application/json');
  }
  function restore(file) {
    const r = new FileReader();
    r.onload = async () => {
      let j; try { j = JSON.parse(r.result); } catch (_) { j = null; }
      if (!j || j.app !== 'painel-obd' || !j.data) { dialog('Arquivo inválido', 'Esse arquivo não é um backup do Painel OBD.'); return; }
      const trips = (JSON.parse(j.data.trips || '[]') || []).length, fl = (JSON.parse(j.data.fuelLogs || '[]') || []).length;
      if ((await dialog('Restaurar backup?', `Backup de ${dmy(new Date(j.created).getTime())}: ${trips} viagem(ns), ${fl} abastecimento(s).\n\nOs dados atuais deste celular serão substituídos.`, [['Cancelar', ''], ['Restaurar', 'danger']])) !== 1) return;
      KEYS.forEach(k => { if (j.data[k] == null) localStorage.removeItem(k); else localStorage.setItem(k, j.data[k]); });
      location.reload();
    };
    r.readAsText(file);
  }

  window.Features = { Trips, Garage, Alerts, Perf, Hud, Report, Odo, backup, exportAll };
})();
