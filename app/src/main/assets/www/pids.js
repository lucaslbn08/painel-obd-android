/* Tabela de PIDs do Modo 01 (SAE J1979) – nomes em português e fórmulas. */
(function () {
  const ab = d => d[0] * 256 + d[1];
  const pct = d => d[0] * 100 / 255;
  const temp = d => d[0] - 40;
  const trim = d => (d[0] - 128) * 100 / 128;
  const s16 = v => (v > 32767 ? v - 65536 : v);

  const FUEL_SYSTEM = {
    0: 'Desligado', 1: 'Malha aberta (motor frio)', 2: 'Malha fechada (usando sonda)',
    4: 'Malha aberta (carga alta/desaceleração)', 8: 'Malha aberta (falha no sistema)',
    16: 'Malha fechada (falha em sonda)'
  };
  const OBD_STD = {
    1: 'OBD-II (CARB)', 2: 'OBD (EPA)', 3: 'OBD e OBD-II', 4: 'OBD-I', 5: 'Sem padrão OBD',
    6: 'EOBD (Europa)', 7: 'EOBD e OBD-II', 8: 'EOBD e OBD', 9: 'EOBD, OBD e OBD-II',
    10: 'JOBD (Japão)', 11: 'JOBD e OBD-II', 12: 'JOBD e EOBD', 13: 'JOBD, EOBD e OBD-II',
    17: 'EMD', 18: 'EMD+', 19: 'HD OBD-C', 20: 'HD OBD', 21: 'WWH OBD', 23: 'HD EOBD-I',
    24: 'HD EOBD-I N', 25: 'HD EOBD-II', 26: 'HD EOBD-II N', 28: 'OBDBr-1 (Brasil)',
    29: 'OBDBr-2 (Brasil)', 30: 'KOBD (Coreia)', 31: 'IOBD I (Índia)', 32: 'IOBD II (Índia)', 33: 'HD EOBD-VI'
  };
  const FUEL_TYPE = {
    0: 'Não informado', 1: 'Gasolina', 2: 'Metanol', 3: 'Etanol', 4: 'Diesel', 5: 'GLP', 6: 'GNV',
    7: 'Propano', 8: 'Elétrico', 9: 'Bicombustível: gasolina', 10: 'Bicombustível: metanol',
    11: 'Bicombustível: etanol', 12: 'Bicombustível: GLP', 13: 'Bicombustível: GNV',
    14: 'Bicombustível: propano', 15: 'Bicombustível: elétrico', 16: 'Bicombustível: elétrico e combustão',
    17: 'Híbrido gasolina', 18: 'Híbrido etanol', 19: 'Híbrido diesel', 20: 'Híbrido elétrico',
    21: 'Híbrido elétrico e combustão', 22: 'Híbrido regenerativo', 23: 'Bicombustível: diesel'
  };
  const SECONDARY_AIR = { 1: 'Antes do catalisador', 2: 'Depois do catalisador', 4: 'Desligado / atmosfera', 8: 'Ligado para diagnóstico' };

  const PIDS = {};
  function p(code, name, unit, nbytes, fn, decimals = 1, group = 'Motor') {
    PIDS[code] = { code, name, unit, nbytes, fn, decimals, group };
  }
  const o2list = bits => {
    const n = [];
    for (let i = 0; i < 8; i++) if (bits & (1 << i)) n.push(`B${1 + (i >> 2)}S${1 + (i % 4)}`);
    return n.length ? n.join(', ') : 'Nenhuma';
  };

  p(0x01, 'Status de falhas (luz de injeção)', '', 4, d => `Luz de injeção ${d[0] & 0x80 ? 'ACESA' : 'apagada'} · ${d[0] & 0x7F} falha(s)`, 0, 'Diagnóstico');
  p(0x03, 'Sistema de combustível', '', 1, d => FUEL_SYSTEM[d[0]] || `Código ${d[0]}`, 0, 'Combustível');
  p(0x04, 'Carga calculada do motor', '%', 1, pct);
  p(0x05, 'Temperatura do motor', '°C', 1, temp, 0);
  p(0x06, 'Correção curta de combustível B1', '%', 1, trim, 1, 'Combustível');
  p(0x07, 'Correção longa de combustível B1', '%', 1, trim, 1, 'Combustível');
  p(0x08, 'Correção curta de combustível B2', '%', 1, trim, 1, 'Combustível');
  p(0x09, 'Correção longa de combustível B2', '%', 1, trim, 1, 'Combustível');
  p(0x0A, 'Pressão de combustível', 'kPa', 1, d => d[0] * 3, 0, 'Combustível');
  p(0x0B, 'Pressão do coletor (MAP)', 'kPa', 1, d => d[0], 0, 'Admissão');
  p(0x0C, 'Rotação do motor', 'rpm', 2, d => ab(d) / 4, 0);
  p(0x0D, 'Velocidade', 'km/h', 1, d => d[0], 0);
  p(0x0E, 'Avanço de ignição', '°', 1, d => d[0] / 2 - 64, 1, 'Ignição');
  p(0x0F, 'Temperatura do ar de admissão', '°C', 1, temp, 0, 'Admissão');
  p(0x10, 'Fluxo de ar (MAF)', 'g/s', 2, d => ab(d) / 100, 2, 'Admissão');
  p(0x11, 'Posição da borboleta', '%', 1, pct, 1, 'Admissão');
  p(0x12, 'Ar secundário comandado', '', 1, d => SECONDARY_AIR[d[0]] || `Código ${d[0]}`, 0, 'Emissões');
  p(0x13, 'Sondas lambda presentes', '', 1, d => o2list(d[0]), 0, 'Sondas lambda');
  for (let i = 0; i < 8; i++) p(0x14 + i, `Sonda lambda B${1 + (i >> 2)}S${1 + (i % 4)} (tensão)`, 'V', 2, d => d[0] / 200, 3, 'Sondas lambda');
  p(0x1C, 'Padrão OBD do veículo', '', 1, d => OBD_STD[d[0]] || `Código ${d[0]}`, 0, 'Veículo');
  p(0x1E, 'Tomada de força (PTO)', '', 1, d => (d[0] & 1 ? 'Ativa' : 'Inativa'), 0, 'Veículo');
  p(0x1F, 'Tempo desde a partida', 's', 2, ab, 0, 'Veículo');
  p(0x21, 'Distância com luz de injeção acesa', 'km', 2, ab, 0, 'Diagnóstico');
  p(0x22, 'Pressão do trilho (relativa ao vácuo)', 'kPa', 2, d => ab(d) * 0.079, 1, 'Combustível');
  p(0x23, 'Pressão do trilho (direta)', 'kPa', 2, d => ab(d) * 10, 0, 'Combustível');
  for (let i = 0; i < 8; i++) p(0x24 + i, `Sonda banda larga S${i + 1} (lambda)`, 'λ', 4, d => ab(d) * 2 / 65536, 3, 'Sondas lambda');
  p(0x2C, 'EGR comandada', '%', 1, pct, 1, 'Emissões');
  p(0x2D, 'Erro da EGR', '%', 1, trim, 1, 'Emissões');
  p(0x2E, 'Purga do cânister comandada', '%', 1, pct, 1, 'Emissões');
  p(0x2F, 'Nível de combustível', '%', 1, pct, 0, 'Combustível');
  p(0x30, 'Aquecimentos desde a limpeza de falhas', '', 1, d => d[0], 0, 'Diagnóstico');
  p(0x31, 'Distância desde a limpeza de falhas', 'km', 2, ab, 0, 'Diagnóstico');
  p(0x32, 'Pressão de vapor do cânister', 'Pa', 2, d => s16(ab(d)) / 4, 1, 'Emissões');
  p(0x33, 'Pressão barométrica', 'kPa', 1, d => d[0], 0, 'Admissão');
  for (let i = 0; i < 8; i++) p(0x34 + i, `Sonda banda larga S${i + 1} (lambda, corrente)`, 'λ', 4, d => ab(d) * 2 / 65536, 3, 'Sondas lambda');
  p(0x3C, 'Temperatura do catalisador B1S1', '°C', 2, d => ab(d) / 10 - 40, 0, 'Emissões');
  p(0x3D, 'Temperatura do catalisador B2S1', '°C', 2, d => ab(d) / 10 - 40, 0, 'Emissões');
  p(0x3E, 'Temperatura do catalisador B1S2', '°C', 2, d => ab(d) / 10 - 40, 0, 'Emissões');
  p(0x3F, 'Temperatura do catalisador B2S2', '°C', 2, d => ab(d) / 10 - 40, 0, 'Emissões');
  p(0x41, 'Status dos monitores (ciclo atual)', '', 4, d => d.slice(0, 4).map(x => x.toString(16).padStart(2, '0').toUpperCase()).join(' '), 0, 'Diagnóstico');
  p(0x42, 'Tensão do módulo (bateria)', 'V', 2, d => ab(d) / 1000, 2, 'Elétrica');
  p(0x43, 'Carga absoluta do motor', '%', 2, d => ab(d) * 100 / 255, 1);
  p(0x44, 'Lambda comandada', 'λ', 2, d => ab(d) * 2 / 65536, 3, 'Combustível');
  p(0x45, 'Posição relativa da borboleta', '%', 1, pct, 1, 'Admissão');
  p(0x46, 'Temperatura ambiente', '°C', 1, temp, 0, 'Veículo');
  p(0x47, 'Posição absoluta da borboleta B', '%', 1, pct, 1, 'Admissão');
  p(0x48, 'Posição absoluta da borboleta C', '%', 1, pct, 1, 'Admissão');
  p(0x49, 'Pedal do acelerador D', '%', 1, pct, 1, 'Admissão');
  p(0x4A, 'Pedal do acelerador E', '%', 1, pct, 1, 'Admissão');
  p(0x4B, 'Pedal do acelerador F', '%', 1, pct, 1, 'Admissão');
  p(0x4C, 'Atuador da borboleta comandado', '%', 1, pct, 1, 'Admissão');
  p(0x4D, 'Tempo com luz de injeção acesa', 'min', 2, ab, 0, 'Diagnóstico');
  p(0x4E, 'Tempo desde a limpeza de falhas', 'min', 2, ab, 0, 'Diagnóstico');
  p(0x50, 'Fluxo de ar máximo (MAF)', 'g/s', 1, d => d[0] * 10, 0, 'Admissão');
  p(0x51, 'Tipo de combustível', '', 1, d => FUEL_TYPE[d[0]] || `Código ${d[0]}`, 0, 'Combustível');
  p(0x52, 'Teor de etanol no combustível', '%', 1, pct, 0, 'Combustível');
  p(0x53, 'Pressão absoluta do cânister', 'kPa', 2, d => ab(d) / 200, 2, 'Emissões');
  p(0x54, 'Pressão do cânister', 'Pa', 2, d => s16(ab(d)), 0, 'Emissões');
  p(0x55, 'Correção curta sonda secundária B1', '%', 1, trim, 1, 'Combustível');
  p(0x56, 'Correção longa sonda secundária B1', '%', 1, trim, 1, 'Combustível');
  p(0x57, 'Correção curta sonda secundária B2', '%', 1, trim, 1, 'Combustível');
  p(0x58, 'Correção longa sonda secundária B2', '%', 1, trim, 1, 'Combustível');
  p(0x59, 'Pressão absoluta do trilho', 'kPa', 2, d => ab(d) * 10, 0, 'Combustível');
  p(0x5A, 'Posição relativa do pedal', '%', 1, pct, 1, 'Admissão');
  p(0x5B, 'Vida restante da bateria híbrida', '%', 1, pct, 0, 'Elétrica');
  p(0x5C, 'Temperatura do óleo', '°C', 1, temp, 0);
  p(0x5D, 'Ponto de injeção', '°', 2, d => ab(d) / 128 - 210, 2, 'Combustível');
  p(0x5E, 'Consumo do motor', 'L/h', 2, d => ab(d) / 20, 2, 'Combustível');
  p(0x61, 'Torque solicitado pelo motorista', '%', 1, d => d[0] - 125, 0);
  p(0x62, 'Torque real do motor', '%', 1, d => d[0] - 125, 0);
  p(0x63, 'Torque de referência', 'N·m', 2, ab, 0);
  p(0x67, 'Temperatura do motor (sensor 1)', '°C', 2, d => d[1] - 40, 0);
  p(0x68, 'Temperatura do ar (sensor 1)', '°C', 2, d => d[1] - 40, 0, 'Admissão');
  p(0x8E, 'Torque de atrito do motor', '%', 1, d => d[0] - 125, 0);
  p(0xA6, 'Odômetro', 'km', 4, d => ((d[0] * 16777216) + (d[1] << 16) + (d[2] << 8) + d[3]) / 10, 1, 'Veículo');

  const isBitmap = pid => typeof pid === 'number' && pid % 0x20 === 0;
  function decode(pid, data) {
    const e = PIDS[pid];
    if (!e || !data || data.length < e.nbytes) return null;
    try { return e.fn(data); } catch (_) { return null; }
  }
  const nameOf = pid => (PIDS[pid] ? PIDS[pid].name : `PID 0x${hex2(pid)} (valor bruto)`);
  const unitOf = pid => (PIDS[pid] ? PIDS[pid].unit : '');
  const groupOf = pid => (PIDS[pid] ? PIDS[pid].group : 'Outros');
  function fmtValue(pid, v, raw) {
    if (v === null || v === undefined) return raw || '—';
    if (typeof v === 'string') return v;
    const dec = PIDS[pid] ? PIDS[pid].decimals : 1;
    return v.toFixed(dec).replace('.', ',');
  }
  function hex2(n) { return n.toString(16).toUpperCase().padStart(2, '0'); }

  const CONTINUOUS = ['Falha de combustão (misfire)', 'Sistema de combustível', 'Componentes abrangentes'];
  const SPARK = ['Catalisador', 'Catalisador aquecido', 'Sistema evaporativo (cânister)', 'Ar secundário',
    'Ar-condicionado (gás)', 'Sonda lambda', 'Aquecedor da sonda lambda', 'Sistema EGR'];
  const DIESEL = ['Catalisador NMHC', 'Redução de NOx / SCR', null, 'Pressão do turbo', null,
    'Sensor de gases de escape', 'Filtro de partículas (DPF)', 'EGR / VVT'];

  function decodeReadiness(d) {
    if (!d || d.length < 4) return null;
    const [a, b, c, e] = d;
    const diesel = !!(b & 0x08);
    const mons = [];
    CONTINUOUS.forEach((name, i) => {
      const sup = b & (1 << i), inc = b & (1 << (i + 4));
      mons.push([name, !sup ? 'nsup' : (inc ? 'inc' : 'ok')]);
    });
    (diesel ? DIESEL : SPARK).forEach((name, i) => {
      if (!name) return;
      const sup = c & (1 << i), inc = e & (1 << i);
      mons.push([name, !sup ? 'nsup' : (inc ? 'inc' : 'ok')]);
    });
    return { mil: !!(a & 0x80), count: a & 0x7F, diesel, monitors: mons };
  }

  const FREEZE_CANDIDATES = [0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E,
    0x0F, 0x10, 0x11, 0x1F, 0x2F, 0x33, 0x42, 0x43, 0x44, 0x45, 0x46, 0x5C];

  window.OBD = { PIDS, decode, nameOf, unitOf, groupOf, fmtValue, isBitmap, hex2, decodeReadiness, FREEZE_CANDIDATES };
})();
