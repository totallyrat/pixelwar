// Retro sound effects synthesized with WebAudio (no audio files).

import { store } from './net.ts';

class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  muted = store.get('muted') === '1';
  private last = new Map<string, number>();

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp).connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 2;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
  toggle(): boolean {
    this.muted = !this.muted;
    store.set('muted', this.muted ? '1' : '0');
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    return this.muted;
  }
  private ok(key: string, gapMs: number): boolean {
    if (!this.ctx || this.muted) return false;
    const now = performance.now();
    if (now - (this.last.get(key) ?? 0) < gapMs) return false;
    this.last.set(key, now);
    return true;
  }
  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0) {
    const c = this.ctx!, t = c.currentTime + delay;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  private burst(dur: number, vol: number, f0: number, f1: number, type: BiquadFilterType = 'lowpass', delay = 0) {
    const c = this.ctx!, t = c.currentTime + delay;
    const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noise;
    f.type = type;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.master!);
    s.start(t);
    s.stop(t + dur + 0.05);
  }

  click() { if (this.ok('click', 40)) this.tone('square', 900, 700, 0.04, 0.12); }
  error() { if (this.ok('err', 150)) { this.tone('square', 160, 120, 0.12, 0.2); this.tone('square', 130, 90, 0.14, 0.2, 0.1); } }
  build() { if (this.ok('build', 60)) { this.tone('square', 440, 440, 0.06, 0.15); this.tone('square', 660, 660, 0.08, 0.15, 0.07); } }
  built() { if (this.ok('built', 200)) { [523, 659, 784].forEach((f, i) => this.tone('square', f, f, 0.09, 0.12, i * 0.08)); } }
  attack() { if (this.ok('attack', 120)) { this.burst(0.18, 0.35, 2000, 300); this.tone('sawtooth', 180, 90, 0.2, 0.18); } }
  underAttack() { if (this.ok('uatk', 3000)) { this.tone('square', 330, 330, 0.12, 0.2); this.tone('square', 250, 250, 0.16, 0.2, 0.15); } }
  launch() { if (this.ok('launch', 100)) this.burst(0.7, 0.4, 300, 3000, 'bandpass'); }
  explosion(big = false) {
    if (!this.ok('boom', 60)) return;
    this.burst(big ? 1.2 : 0.6, big ? 0.9 : 0.6, 1400, 60);
    this.tone('sine', big ? 120 : 160, 30, big ? 0.9 : 0.4, 0.6);
  }
  nuke(mega = false) {
    if (!this.ok('nuke', 500)) return;
    this.tone('sine', 70, 22, 3.2, 0.9);
    this.burst(4, 1, 2500, 40);
    this.burst(2.5, 0.6, 400, 50, 'lowpass', 0.5);
    this.tone('sawtooth', 55, 30, 2.5, 0.25, 0.1);
    if (mega) {
      // second, deeper wave rolling in after the flash
      this.tone('sine', 48, 16, 5, 1, 0.35);
      this.burst(6, 0.9, 900, 25, 'lowpass', 0.6);
      this.tone('square', 36, 22, 3.5, 0.18, 0.9);
    }
  }
  founded() {
    if (!this.ok('founded', 1000)) return;
    this.burst(0.9, 0.5, 1600, 80);
    this.tone('sine', 140, 40, 0.8, 0.5);
    [392, 523, 659, 784, 1047].forEach((f, i) => this.tone('square', f, f, 0.14, 0.11, 0.35 + i * 0.09));
  }
  siren() {
    if (!this.ok('siren', 4000)) return;
    for (let i = 0; i < 3; i++) { this.tone('sawtooth', 520, 900, 0.5, 0.12, i * 1.0); this.tone('sawtooth', 900, 520, 0.5, 0.12, i * 1.0 + 0.5); }
  }
  intercept() { if (this.ok('ic', 200)) { this.tone('square', 1200, 2400, 0.15, 0.15); this.burst(0.3, 0.3, 4000, 800, 'highpass', 0.1); } }
  ping() { if (this.ok('ping', 200)) { this.tone('triangle', 1320, 1320, 0.25, 0.25); this.tone('triangle', 1760, 1760, 0.3, 0.2, 0.12); } }
  chat() { if (this.ok('chat', 300)) this.tone('square', 1400, 1600, 0.05, 0.08); }
  notify() { if (this.ok('notify', 300)) { this.tone('triangle', 880, 880, 0.08, 0.15); this.tone('triangle', 1175, 1175, 0.12, 0.15, 0.09); } }
  spawn() { if (this.ok('spawn', 300)) [392, 523, 659, 784].forEach((f, i) => this.tone('square', f, f, 0.12, 0.12, i * 0.07)); }
  splash() { if (this.ok('splash', 150)) this.burst(0.5, 0.35, 900, 200); }
  victory() { [523, 659, 784, 1047, 784, 1047].forEach((f, i) => this.tone('square', f, f, 0.16, 0.15, i * 0.14)); }
  defeat() { [392, 349, 311, 262].forEach((f, i) => this.tone('triangle', f, f * 0.98, 0.3, 0.2, i * 0.25)); }
}

export const sfx = new Sfx();
