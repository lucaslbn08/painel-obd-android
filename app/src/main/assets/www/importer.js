/* Importação da exportação CSV do app Drivvo (abastecimentos, serviços e despesas).
   Não substitui nada: junta com o que já existe e ignora o que já foi importado antes. */
(function () {
  function parseLine(line) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map(s => s.trim());
  }
  const n = s => { const v = parseFloat(String(s || '').replace(',', '.')); return isNaN(v) ? null : v; };
  const yes = s => /^(sim|yes|true|1)$/i.test(String(s || '').trim());
  function fuelKey(name) {
    const s = String(name || '').toLowerCase();
    if (/etanol|álcool|alcool/.test(s)) return 'etanol';
    if (/diesel/.test(s)) return 'diesel';
    if (/gnv|gás natural/.test(s)) return 'gnv';
    return 'gasolina';
  }

  /** Lê o texto do CSV do Drivvo e devolve { fuel:[], services:[] } no formato do Painel OBD */
  function parseDrivvo(text) {
    text = text.replace(/^﻿/, '');
    const fuel = [], services = [];
    let section = null, header = true;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('##')) { section = line.slice(2).toLowerCase(); header = true; continue; }
      if (header) { header = false; continue; }
      const c = parseLine(line);
      const km = n(c[0]), date = (c[1] || '').slice(0, 10);
      if (km == null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (section === 'refuelling') {
        const station = c[23] || '';
        // até 3 combustíveis no mesmo abastecimento (colunas 2-6, 7-11, 12-16)
        for (const base of [2, 7, 12]) {
          const liters = n(c[base + 3]), total = n(c[base + 2]);
          if (!liters || liters <= 0) continue;
          fuel.push({ date, km, liters, total, price: n(c[base + 1]) || (total ? total / liters : null), fuel: fuelKey(c[base]),
            fuelName: c[base], full: yes(c[base + 4]), station, note: c[27] || '', src: 'drivvo' });
        }
      } else if (section === 'service' || section === 'expense') {
        const desc = section === 'service' ? (c[8] || c[3]) : (c[3] || c[8]);
        services.push({ date, km, desc: desc || (section === 'service' ? 'Serviço' : 'Despesa'), total: n(c[2]) || 0,
          place: section === 'service' ? (c[4] || '') : '', note: c[7] || '', kind: section === 'service' ? 'servico' : 'despesa', src: 'drivvo' });
      }
    }
    return { fuel, services };
  }

  // Serviços que atualizam os lembretes de manutenção: [palavra-chave, item, a cada km, a cada meses]
  const MAINT_MAP = [
    [/troca de [óo]leo|[óo]leo do motor|^[óo]leo/i, 'Troca de óleo do motor', 5000, 6],
    [/filtro de [óo]leo/i, 'Filtro de óleo', 5000, 6],
    [/filtro de ar(?! condicionado)(?!-condicionado)/i, 'Filtro de ar do motor', 10000, 12],
    [/filtro de combust/i, 'Filtro de combustível', 20000, 12],
    [/filtro (de )?(cabine|ar[- ]condicionado|anti.?p[óo]len)/i, 'Filtro do ar-condicionado', 10000, 12],
    [/velas?/i, 'Velas de ignição', 30000, 0],
    [/fluido de freio|[óo]leo de freio/i, 'Fluido de freio', 0, 24],
    [/arrefecimento|radiador|aditivo/i, 'Líquido de arrefecimento', 40000, 24],
    [/alinhamento|balanceamento/i, 'Alinhamento e balanceamento', 10000, 0],
    [/pastilha/i, 'Pastilhas de freio (verificar)', 20000, 0],
    [/correia dentada/i, 'Correia dentada (confira o manual)', 50000, 48]
  ];
  const matchMaint = desc => MAINT_MAP.find(([re]) => re.test(desc || ''));

  window.Importer = { parseDrivvo, parseLine, matchMaint, MAINT_MAP };
})();
