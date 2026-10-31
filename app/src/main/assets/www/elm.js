/* Comunicação com o ELM327 + transporte Bluetooth (ponte Android) + motor de leitura. */
(function () {
  const PROTOCOLS = {
    '0': 'Automático', '1': 'SAE J1850 PWM (41,6 kbaud)', '2': 'SAE J1850 VPW (10,4 kbaud)',
    '3': 'ISO 9141-2 (linha K)', '4': 'ISO 14230-4 KWP2000 (início 5 baud)',
    '5': 'ISO 14230-4 KWP2000 (início rápido)', '6': 'ISO 15765-4 CAN (11 bit, 500 kbaud)',
    '7': 'ISO 15765-4 CAN (29 bit, 500 kbaud)', '8': 'ISO 15765-4 CAN (11 bit, 250 kbaud)',
    '9': 'ISO 15765-4 CAN (29 bit, 250 kbaud)', 'A': 'SAE J1939 CAN (29 bit, 250 kbaud)',
    'B': 'CAN definido pelo usuário 1', 'C': 'CAN definido pelo usuário 2'
  };

  class ELMError extends Error {}
  class LinkLost extends ELMError {}

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function hexBytes(s) {
    if (s.length % 2) s = s.slice(0, -1);
    const out = [];
    for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.substr(i, 2), 16));
    return out;
  }

  /* ---------- Transporte pela ponte Bluetooth do app Android ---------- */
  class BridgeTransport {
    constructor(address) { this.address = address; this.onData = null; this.onClose = null; }
    open() {
      return new Promise((resolve, reject) => {
        BridgeTransport.current = this;
        this._pending = { resolve, reject };
        window.AndroidBT.connect(this.address);
      });
    }
    write(s) { window.AndroidBT.write(s); }
    close() { try { window.AndroidBT.disconnect(); } catch (_) {} }
  }
  // Eventos chamados pelo código Java
  window.btData = s => { const t = BridgeTransport.current; if (t && t.onData) t.onData(s); };
  window.btEvent = (kind, msg) => {
    const t = BridgeTransport.current;
    if (kind === 'perm') { if (window.onBtPermission) window.onBtPermission(msg === 'granted'); return; }
    if (!t) return;
    if (kind === 'connected' && t._pending) { t._pending.resolve(); t._pending = null; }
    else if (kind === 'error' && t._pending) { t._pending.reject(new ELMError(msg)); t._pending = null; }
    else if (kind === 'closed') { if (t.onClose) t.onClose(msg); }
  };

  /* ---------- ELM327 ---------- */
  class ELM327 {
    constructor(t) {
      this.t = t; this.buf = ''; this.waiter = null; this.lost = null;
      this.version = 'ELM327'; this.protocolNum = '?'; this.protocolName = '—';
      t.onData = s => {
        this.buf += s;
        if (this.waiter && this.buf.includes('>')) { const w = this.waiter; this.waiter = null; w.res(); }
      };
      t.onClose = msg => {
        this.lost = msg || 'adaptador desconectado';
        if (this.waiter) { const w = this.waiter; this.waiter = null; w.rej(new LinkLost(`A conexão com o adaptador caiu (${this.lost}).`)); }
      };
    }

    async send(cmd, timeout = 4000) {
      if (this.lost) throw new LinkLost(`A conexão com o adaptador caiu (${this.lost}).`);
      this.buf = '';
      this.t.write(cmd + '\r');
      await new Promise((res, rej) => {
        if (this.buf.includes('>')) return res();
        const to = setTimeout(() => { this.waiter = null; rej(new ELMError(`O adaptador não respondeu ao comando ${cmd}.`)); }, timeout);
        this.waiter = { res: () => { clearTimeout(to); res(); }, rej: e => { clearTimeout(to); rej(e); } };
      });
      const text = this.buf.split('>')[0];
      this.buf = '';
      const target = cmd.replace(/ /g, '').toUpperCase();
      return text.split(/[\r\n]+/).map(l => l.trim().replace(/\0/g, ''))
        .filter(l => l && l.replace(/ /g, '').toUpperCase() !== target);
    }

    static parse(lines) {
      const msgs = []; let cur = null, expect = null;
      for (const raw of lines) {
        const line = raw.replace(/ /g, '').toUpperCase();
        if (!line || line.startsWith('SEARCHING')) continue;
        let m = line.match(/^([0-9A-F]):([0-9A-F]*)$/);
        if (m) {
          const data = hexBytes(m[2]);
          if (m[1] === '0' || !cur) { cur = { d: data, n: expect }; msgs.push(cur); expect = null; }
          else cur.d.push(...data);
          continue;
        }
        if (/^[0-9A-F]{3}$/.test(line)) { expect = parseInt(line, 16); cur = null; continue; }
        if (/^[0-9A-F]+$/.test(line)) { msgs.push({ d: hexBytes(line), n: null }); cur = null; }
      }
      return msgs.map(x => (x.n ? x.d.slice(0, x.n) : x.d));
    }

    async request(cmd, timeout = 4000) { return ELM327.parse(await this.send(cmd, timeout)); }

    async connect() {
      let lines;
      try { lines = await this.send('ATZ', 6000); }
      catch (e) {
        if (e instanceof LinkLost) throw e;
        this.t.write('\r'); await sleep(500);
        lines = await this.send('ATZ', 6000);
      }
      await sleep(300);
      for (const l of lines) if (l.toUpperCase().includes('ELM')) this.version = l.trim();
      for (const c of ['ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATAT1', 'ATSP0']) await this.send(c, 3000);
      const msgs = await this.request('0100', 25000);
      if (!msgs.some(m => m.length >= 2 && m[0] === 0x41 && m[1] === 0x00)) {
        throw new ELMError('O adaptador está funcionando, mas o carro não respondeu.\n\n' +
          '• Confira se a ignição está ligada (painel aceso) ou o motor funcionando.\n' +
          '• Confira se o adaptador está bem encaixado na tomada OBD.\n' +
          '• Se continuar, o carro pode não ser compatível com OBD-II padrão.');
      }
      const dp = await this.send('ATDPN', 3000);
      let num = (dp[0] || '?').trim().toUpperCase();
      if (num.startsWith('A') && num.length > 1) num = num.slice(1);
      this.protocolNum = num;
      this.protocolName = PROTOCOLS[num] || `Protocolo ${num}`;
    }

    async getPid(pid) {
      for (const m of await this.request('01' + OBD.hex2(pid)))
        if (m.length >= 2 && m[0] === 0x41 && m[1] === pid) return m.slice(2);
      return null;
    }

    async supportedPids() {
      const sup = new Set(); let base = 0;
      while (base <= 0xE0) {
        let bits = 0;
        for (const m of await this.request('01' + OBD.hex2(base), 6000))
          if (m.length >= 6 && m[0] === 0x41 && m[1] === base)
            bits = (bits | ((m[2] << 24) | (m[3] << 16) | (m[4] << 8) | m[5])) >>> 0;
        if (!bits) break;
        for (let i = 0; i < 32; i++) if ((bits >>> (31 - i)) & 1) sup.add(base + i + 1);
        if (!sup.has(base + 0x20)) break;
        base += 0x20;
      }
      return sup;
    }

    async readDtcs(mode = '03') {
      const resp = parseInt(mode, 16) + 0x40, codes = [];
      for (const m of await this.request(mode, 8000)) {
        if (!m.length || m[0] !== resp) continue;
        let data = m.slice(1);
        if (data.length % 2 === 1) data = data.slice(1);
        for (let i = 0; i + 1 < data.length; i += 2) {
          if (!data[i] && !data[i + 1]) continue;
          const c = DTC.decodeDtc(data[i], data[i + 1]);
          if (!codes.includes(c)) codes.push(c);
        }
      }
      return codes;
    }

    async clearDtcs() { return (await this.request('04', 10000)).some(m => m.length && m[0] === 0x44); }

    async getFreeze(pid) {
      for (const m of await this.request('02' + OBD.hex2(pid) + '00'))
        if (m.length >= 3 && m[0] === 0x42 && m[1] === pid) return m.slice(3);
      return null;
    }

    async readText(pid) {
      const out = [];
      for (const m of await this.request('09' + OBD.hex2(pid), 6000))
        if (m.length >= 3 && m[0] === 0x49 && m[1] === pid) out.push(...m.slice(3));
      let t = out.filter(c => c >= 32 && c < 127).map(c => String.fromCharCode(c)).join('').trim();
      if (pid === 0x02 && t.length > 17) t = t.slice(-17);
      return t;
    }

    async voltage() {
      let lines;
      try { lines = await this.send('ATRV', 2000); }
      catch (e) { if (e instanceof LinkLost) throw e; return null; }
      for (const l of lines) { const m = l.toUpperCase().match(/(\d+(?:\.\d+)?)\s*V/); if (m) return parseFloat(m[1]); }
      return null;
    }
  }

  /* ---------- Motor: conecta e lê em ciclo, executando tarefas pedidas pela tela ---------- */
  const FAST = [0x0C, 0x0D, 0x04, 0x11];

  class Engine {
    constructor(transport, emit) {
      this.t = transport; this.emit = emit; this.jobs = []; this.stopped = false;
      this.slowPerCycle = 2; this.fails = 0;
    }
    stop() { this.stopped = true; this.t.close(); }
    submit(...job) { this.jobs.push(job); }

    async run() {
      try {
        this.emit('status', 'Abrindo conexão com o adaptador…');
        await this.t.open();
        const elm = new ELM327(this.t);
        this.elm = elm;
        this.emit('status', 'Procurando o protocolo do carro (até 25 s)…');
        await elm.connect();
        this.emit('status', 'Lendo a lista de dados que o carro fornece…');
        const sup = await elm.supportedPids();
        const info = { version: elm.version, protocol: elm.protocolName, supported: [...sup].sort((a, b) => a - b) };
        for (const [key, pid] of [['vin', 0x02], ['calid', 0x04], ['ecu', 0x0A]]) {
          try { info[key] = await elm.readText(pid); }
          catch (e) { if (e instanceof LinkLost) throw e; info[key] = ''; }
        }
        this.emit('connected', info);
        this.submit('dtc');
        await this.loop(elm, sup);
      } catch (e) {
        if (!this.stopped) this.emit('error', e.message || String(e));
      } finally {
        try { this.t.close(); } catch (_) {}
        this.emit('disconnected');
      }
    }

    async read(elm, pid, batch) {
      let data;
      try { data = await elm.getPid(pid); }
      catch (e) {
        if (e instanceof LinkLost) throw e;
        if (++this.fails >= 6) throw new ELMError('A comunicação com o adaptador foi perdida.\n\nConfira se a ignição continua ligada e se o adaptador está encaixado.');
        return;
      }
      this.fails = 0;
      if (data) batch[pid] = [data.map(x => OBD.hex2(x)).join(' '), OBD.decode(pid, data)];
    }

    async loop(elm, sup) {
      const fast = FAST.filter(p => sup.has(p));
      const slow = [...sup].sort((a, b) => a - b).filter(p => !OBD.isBitmap(p) && !fast.includes(p) && p !== 0x02);
      let idx = 0, lastV = 0;
      while (!this.stopped) {
        await this.runJobs(elm, sup);
        const batch = {};
        for (const p of fast) { if (this.stopped) return; await this.read(elm, p, batch); }
        for (let i = 0; i < Math.min(this.slowPerCycle, slow.length); i++) {
          if (this.stopped) return;
          await this.read(elm, slow[idx++ % slow.length], batch);
        }
        if (Date.now() - lastV >= 2000) {
          const v = await elm.voltage();
          if (v !== null) batch.V = [String(v), v];
          lastV = Date.now();
        }
        if (Object.keys(batch).length) this.emit('data', batch, Date.now());
        else await sleep(250);
      }
    }

    async runJobs(elm, sup) {
      while (this.jobs.length && !this.stopped) {
        const job = this.jobs.shift(), kind = job[0];
        try {
          if (kind === 'dtc') {
            const res = { stored: await elm.readDtcs('03'), pending: await elm.readDtcs('07'), permanent: await elm.readDtcs('0A') };
            res.readiness = OBD.decodeReadiness(await elm.getPid(0x01));
            this.emit('dtc', res);
          } else if (kind === 'clear') {
            this.emit('cleared', await elm.clearDtcs());
            await sleep(500);
            this.submit('dtc');
          } else if (kind === 'freeze') {
            const rows = [];
            const d = await elm.getFreeze(0x02);
            if (d && d.length >= 2 && (d[0] || d[1])) {
              rows.push(['Falha que gerou o registro', DTC.decodeDtc(d[0], d[1]), '']);
              for (const p of OBD.FREEZE_CANDIDATES) {
                if (!sup.has(p)) continue;
                const data = await elm.getFreeze(p);
                if (data) rows.push([OBD.nameOf(p), OBD.fmtValue(p, OBD.decode(p, data)), OBD.unitOf(p)]);
              }
            }
            this.emit('freeze', rows);
          } else if (kind === 'readiness') {
            this.emit('readiness', OBD.decodeReadiness(await elm.getPid(0x01)));
          } else if (kind === 'raw') {
            this.emit('raw', job[1], await elm.send(job[1], 10000));
          }
        } catch (e) {
          if (e instanceof LinkLost) throw e;
          this.emit('job_error', kind, e.message);
        }
      }
    }
  }

  window.ELM = { ELM327, Engine, BridgeTransport, ELMError, LinkLost, PROTOCOLS, sleep };
})();
