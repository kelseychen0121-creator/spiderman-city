// Tiny WebAudio SFX manager: one-shots + volume-controlled loops.
// init() must be called from a user gesture (pointer-lock click qualifies).
export class Sfx {
  constructor(map) {
    this.map = map;          // name -> url
    this.ctx = null;
    this.buffers = {};
    this.loops = {};
    this.ready = false;
    this._initing = null;
  }

  init() {
    if (this._initing) { this.resume(); return this._initing; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    this._initing = Promise.all(Object.entries(this.map).map(async ([k, u]) => {
      const ab = await (await fetch(u)).arrayBuffer();
      this.buffers[k] = await this.ctx.decodeAudioData(ab);
    })).then(() => { this.ready = true; })
      .catch(e => console.warn('sfx load failed', e));
    return this._initing;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  play(name, { volume = 1, rate = 1 } = {}) {
    if (!this.ready || !this.buffers[name]) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers[name];
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(this.ctx.destination);
    src.start();
  }

  startLoop(name, volume = 0) {
    if (!this.ready || !this.buffers[name] || this.loops[name]) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers[name];
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(this.ctx.destination);
    src.start();
    this.loops[name] = { src, g };
  }

  setLoopVolume(name, v, smooth = 0.08) {
    const l = this.loops[name];
    if (l) l.g.gain.setTargetAtTime(v, this.ctx.currentTime, smooth);
  }

  setLoopRate(name, rate, smooth = 0.08) {
    const l = this.loops[name];
    if (l) l.src.playbackRate.setTargetAtTime(rate, this.ctx.currentTime, smooth);
  }

  stopLoop(name, fade = 0.12) {
    const l = this.loops[name];
    if (!l) return;
    l.g.gain.setTargetAtTime(0, this.ctx.currentTime, fade);
    const src = l.src;
    setTimeout(() => { try { src.stop(); } catch (e) { /* already stopped */ } }, fade * 1000 + 400);
    delete this.loops[name];
  }
}
