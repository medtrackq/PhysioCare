/**
 * วิดีโอคอลแบบ 1:1 ด้วย WebRTC (ใช้ทั้งหน้าของนักกายภาพและหน้าผู้ป่วย /call)
 *
 *   ภาพ/เสียงวิ่งตรงระหว่างสองเครื่อง เข้ารหัสด้วย DTLS-SRTP เสมอ — server ส่งต่อแค่สัญญาณ (SDP + ICE)
 *   นักกายภาพเป็นฝ่ายสร้าง offer ทุกครั้งที่ผู้ป่วยเข้าห้อง (เชื่อมใหม่เองเมื่อหลุดหรือรีเฟรชหน้า)
 *
 *   const call = new CallClient({ role, streamUrl, signalUrl, headers, iceServers, localStream, on: { remote, state, presence, closed } })
 *   call.start(); call.replaceVideoTrack(track); call.hangup();
 */

/** อ่าน Server-Sent Events ผ่าน fetch (ส่ง header ยืนยันตัวได้ ต่างจาก EventSource) */
async function readEvents(url, headers, onEvent, signal) {
  const res = await fetch(url, { headers: { Accept: 'text/event-stream', ...headers }, signal, cache: 'no-store' });
  if (!res.ok || !res.body) {
    const err = new Error(`signal stream ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (ev) {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { /* ข้าม */ }
        onEvent(ev, parsed);
      }
    }
  }
}

export class CallClient {
  constructor({ role, streamUrl, signalUrl, headers = {}, iceServers = [], localStream, on = {} }) {
    Object.assign(this, { role, streamUrl, signalUrl, headers, iceServers, localStream, on });
    this.pc = null;
    this.pendingIce = [];
    this.peerPresent = false;
    this.stopped = false;
    this.abort = null;
    this.retry = 0;
  }

  start() { this.#listen(); }

  async #listen() {
    while (!this.stopped) {
      this.abort = new AbortController();
      try {
        await readEvents(this.streamUrl, this.headers, (ev, data) => { this.retry = 0; this.#onEvent(ev, data); }, this.abort.signal);
      } catch (err) {
        if (this.stopped) return;
        if (err.status === 409 || err.status === 401 || err.status === 404) { this.#close(err.status === 409 ? 'not_open' : 'invalid'); return; }
      }
      if (this.stopped) return;
      this.on.state?.('reconnecting');
      this.retry = Math.min(this.retry + 1, 5);
      await new Promise((r) => setTimeout(r, 800 * this.retry));
    }
  }

  async #send(type, data) {
    try {
      await fetch(this.signalUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', ...this.headers }, body: JSON.stringify({ type, data }) });
    } catch { /* เครือข่ายสะดุด — ICE/offer จะถูกส่งใหม่เมื่อเชื่อมใหม่ */ }
  }

  #onEvent(ev, data) {
    if (ev === 'presence') {
      const other = this.role === 'staff' ? data.patient : data.staff;
      const joined = other && !this.peerPresent;
      this.peerPresent = Boolean(other);
      this.on.presence?.(data);
      if (!other) { this.#resetPc(); this.on.state?.('waiting'); return; }
      if (this.role === 'staff' && (joined || !this.pc || ['failed', 'closed', 'disconnected'].includes(this.pc.connectionState))) this.#offer();
      return;
    }
    if (ev === 'signal') { this.#onSignal(data); return; }
    if (ev === 'replaced') { this.#close('replaced'); return; }
    if (ev === 'closed') this.#close(data?.reason || 'closed');
  }

  #newPc() {
    this.#resetPc();
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;
    this.pendingIce = [];
    for (const t of this.localStream?.getTracks() || []) pc.addTrack(t, this.localStream);
    pc.onicecandidate = (e) => { if (e.candidate) this.#send('ice', e.candidate.toJSON()); };
    pc.ontrack = (e) => this.on.remote?.(e.streams[0] || new MediaStream([e.track]));
    pc.onconnectionstatechange = () => {
      if (pc !== this.pc) return;
      this.on.state?.(pc.connectionState);
      // ICE ล้มเหลว (เช่น เปลี่ยนจาก Wi-Fi เป็น 4G): ฝ่ายนักกายภาพเริ่มต่อใหม่
      if (pc.connectionState === 'failed' && this.role === 'staff') this.#offer({ iceRestart: true });
    };
    return pc;
  }

  #resetPc() {
    if (this.pc) { try { this.pc.close(); } catch { /* ปิดแล้ว */ } }
    this.pc = null;
  }

  async #offer({ iceRestart = false } = {}) {
    const pc = iceRestart && this.pc ? this.pc : this.#newPc();
    this.on.state?.('connecting');
    const offer = await pc.createOffer({ iceRestart });
    await pc.setLocalDescription(offer);
    await this.#send('offer', pc.localDescription.toJSON());
  }

  async #onSignal({ type, data }) {
    try {
      if (type === 'offer' && this.role === 'patient') {
        const pc = this.pc && this.pc.signalingState !== 'closed' && this.pc.connectionState !== 'failed' ? this.pc : this.#newPc();
        this.on.state?.('connecting');
        await pc.setRemoteDescription(data);
        await this.#flushIce();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.#send('answer', pc.localDescription.toJSON());
      } else if (type === 'answer' && this.role === 'staff' && this.pc) {
        await this.pc.setRemoteDescription(data);
        await this.#flushIce();
      } else if (type === 'ice') {
        if (this.pc?.remoteDescription) await this.pc.addIceCandidate(data).catch(() => {});
        else this.pendingIce.push(data);
      } else if (type === 'bye') {
        this.#resetPc();
        this.on.state?.('waiting');
      } else if (type === 'state') {
        this.on.peerState?.(data);
      }
    } catch (err) {
      console.warn('[rtc]', err);
    }
  }

  async #flushIce() {
    const list = this.pendingIce;
    this.pendingIce = [];
    for (const c of list) await this.pc.addIceCandidate(c).catch(() => {});
  }

  /** แจ้งอีกฝ่าย เช่น ปิดไมค์/กล้อง */
  sendState(state) { this.#send('state', state); }

  /** เปลี่ยนกล้อง (หน้า/หลัง) โดยไม่ต้องต่อสายใหม่ */
  async replaceVideoTrack(track) {
    const sender = this.pc?.getSenders().find((s) => s.track?.kind === 'video');
    if (sender) await sender.replaceTrack(track);
  }

  async stats() {
    if (!this.pc) return null;
    const r = await this.pc.getStats();
    let pair = null;
    r.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
    if (!pair) return null;
    const local = r.get(pair.localCandidateId);
    return { relayed: local?.candidateType === 'relay', rttMs: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null };
  }

  #close(reason) {
    if (this.stopped) return;
    this.stopped = true;
    this.abort?.abort();
    this.#resetPc();
    this.on.closed?.(reason);
  }

  async hangup() {
    if (this.stopped) return;
    await this.#send('bye');
    this.#close('hangup');
  }
}

/** เปิดกล้อง+ไมค์ (ถ้าไม่มีกล้องใช้เสียงอย่างเดียว) */
export async function getMedia(facingMode = 'user') {
  const video = { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } };
  try { return await navigator.mediaDevices.getUserMedia({ video, audio: { echoCancellation: true, noiseSuppression: true } }); } catch (err) {
    if (err?.name === 'NotAllowedError') throw err;
    return navigator.mediaDevices.getUserMedia({ audio: true });
  }
}
