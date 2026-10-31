/* Carro simulado: imita um ELM327 ligado a um veículo, para testar sem o carro. */
(function () {
  const SUPPORTED = [0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x13,
    0x14, 0x15, 0x1C, 0x1F, 0x21, 0x2F, 0x30, 0x31, 0x33, 0x3C, 0x42, 0x43, 0x44, 0x45,
    0x46, 0x47, 0x49, 0x4A, 0x4C, 0x51, 0x52, 0x5C, 0x5E];
  const VIN = '9BWZZZ377VT004251';
  const rnd = (a, b) => a + Math.random() * (b - a);
  const h2 = n => n.toString(16).toUpperCase().padStart(2, '0');

  class DemoTransport {
    constructor() { this.onData = null; this.onClose = null; this.t0 = Date.now(); this.stored = ['P0420', 'P0171']; this.pending = ['P0300']; this.closed = false; }
    open() { return new Promise(r => setTimeout(r, 600)); }
    close() { this.closed = true; }
    write(s) {
      const cmd = s.trim().toUpperCase().replace(/ /g, '');
      const resp = this.handle(cmd);
      const delay = cmd === '0100' && Date.now() - this.t0 < 8000 ? 2500 : 30;
      setTimeout(() => { if (!this.closed && this.onData) this.onData(resp + '\r\r>'); }, delay);
    }
    state() {
      const t = (Date.now() - this.t0) / 1000;
      const speed = Math.max(0, 62 + 58 * Math.sin(t / 11) + 6 * Math.sin(t / 2.3));
      const gear = speed > 3 ? speed * 34 : 0;
      const rpm = Math.min(6900, 820 + gear * (1 + 0.35 * Math.sin(t / 3.1)) + rnd(-25, 25));
      const thr = Math.max(0, Math.min(100, 14 + 30 * Math.sin(t / 3.1) + speed * 0.2));
      const load = Math.max(15, Math.min(100, 20 + thr * 0.7));
      return { t, speed, rpm, thr, load, ect: Math.min(91, 32 + t * 1.4), iat: 31 + 3 * Math.sin(t / 30),
        maf: 2.5 + rpm / 1000 * load / 12, map: 30 + load * 0.65, adv: 12 + 14 * (1 - load / 100),
        stft: rnd(-4, 4), ltft: 3.1, fuel: Math.max(5, 63 - t / 60), volt: 14.1 + rnd(-0.1, 0.1) };
    }
    bitmap(base) {
      let bits = 0;
      for (const p of SUPPORTED) if (p > base && p <= base + 32) bits = (bits | (1 << (32 - (p - base)))) >>> 0;
      if (SUPPORTED.some(p => p > base + 32)) bits = (bits | 1) >>> 0;
      return bits.toString(16).toUpperCase().padStart(8, '0');
    }
    raw(pid, s) {
      const b1 = v => [Math.round(Math.max(0, Math.min(255, v)))];
      const b2 = v => { v = Math.round(Math.max(0, Math.min(65535, v))); return [v >> 8, v & 255]; };
      const mil = this.stored.length ? 0x80 : 0;
      const T = {
        0x01: [mil | this.stored.length, 0x07, 0x65, 0x04], 0x03: [2, 0], 0x04: b1(s.load * 2.55),
        0x05: b1(s.ect + 40), 0x06: b1(128 + s.stft * 1.28), 0x07: b1(128 + s.ltft * 1.28), 0x0B: b1(s.map),
        0x0C: b2(s.rpm * 4), 0x0D: b1(s.speed), 0x0E: b1((s.adv + 64) * 2), 0x0F: b1(s.iat + 40),
        0x10: b2(s.maf * 100), 0x11: b1(s.thr * 2.55), 0x13: [0x03],
        0x14: [Math.round(90 + 80 * (0.5 + 0.5 * Math.sin(s.t * 3))), 128],
        0x15: [Math.round(130 + 10 * Math.sin(s.t / 5)), 255], 0x1C: [28], 0x1F: b2(s.t + 300),
        0x21: b2(this.stored.length ? 42 : 0), 0x2F: b1(s.fuel * 2.55), 0x30: [12], 0x31: b2(318), 0x33: [93],
        0x3C: b2((480 + s.load * 3 + 40) * 10), 0x42: b2(s.volt * 1000), 0x43: b2(s.load * 2.3),
        0x44: b2(32768 * (s.load < 85 ? 1 : 0.9)), 0x45: b1(s.thr * 2.55), 0x46: [67],
        0x47: b1(s.thr * 2.55 + 20), 0x49: b1(s.thr * 2.55 * 0.9 + 15), 0x4A: b1(s.thr * 2.55 * 0.45 + 8),
        0x4C: b1(s.thr * 2.55), 0x51: [1], 0x52: b1(27 * 2.55), 0x5C: b1(s.ect + 36),
        0x5E: b2(s.maf * 3600 / (14 * 750) * 20)
      };
      return T[pid] || null;
    }
    dtcResp(head, codes) {
      const d = [codes.length];
      for (const c of codes) d.push(...DTC.encodeDtc(c));
      return head + d.map(h2).join('');
    }
    handle(cmd) {
      if (cmd.startsWith('AT')) {
        if (['ATZ', 'ATI', 'ATWS'].includes(cmd)) return 'ELM327 v1.5';
        if (cmd === 'ATRV') return this.state().volt.toFixed(1) + 'V';
        if (cmd === 'ATDPN') return 'A6';
        if (cmd === 'ATDP') return 'AUTO, ISO 15765-4 (CAN 11/500)';
        return 'OK';
      }
      if (cmd.startsWith('01') && cmd.length >= 4) {
        const pid = parseInt(cmd.slice(2, 4), 16);
        if (pid % 0x20 === 0) return '41' + h2(pid) + this.bitmap(pid);
        const r = SUPPORTED.includes(pid) ? this.raw(pid, this.state()) : null;
        return r ? '41' + h2(pid) + r.map(h2).join('') : 'NO DATA';
      }
      if (cmd.startsWith('02') && cmd.length >= 6) {
        const pid = parseInt(cmd.slice(2, 4), 16);
        if (pid === 0x02) return '420200' + (this.stored.length ? DTC.encodeDtc(this.stored[0]).map(h2).join('') : '0000');
        const r = SUPPORTED.includes(pid) && this.stored.length ? this.raw(pid, this.state()) : null;
        return r ? '42' + h2(pid) + '00' + r.map(h2).join('') : 'NO DATA';
      }
      if (cmd === '03') return this.dtcResp('43', this.stored);
      if (cmd === '07') return this.dtcResp('47', this.pending);
      if (cmd === '0A') return '4A00';
      if (cmd === '04') { this.stored = []; this.pending = []; return '44'; }
      if (cmd === '0902') {
        const hex = '490201' + [...VIN].map(c => h2(c.charCodeAt(0))).join('');
        return '014\r0:' + hex.slice(0, 12) + '\r1:' + hex.slice(12, 26) + '\r2:' + hex.slice(26, 40);
      }
      if (cmd === '0904') return '014\r0:490401444556\r1:4F2D534D2D3132\r2:33340000000000';
      return 'NO DATA';
    }
  }
  window.DemoTransport = DemoTransport;
})();
