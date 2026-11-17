// Render the shared Rust plan. No platform-specific loudness policy.
export class OutputGain {
  private enabled: boolean = false;
  private revision: number = -1;
  private gainDb: number = 0;
  private from: number = 0;
  private target: number = 0;
  private began: number = 0;
  configure(value: boolean, version: number): boolean {
    if (!Number.isFinite(version) || version < this.revision) return false;
    this.enabled = value; this.revision = version; return true;
  }
  plan(db: number): void { this.gainDb = Number.isFinite(db) ? Math.max(-80,Math.min(0,db)) : 0; }
  current(now: number): number { return this.from+(this.target-this.from)*Math.max(0,Math.min(1,(now-this.began)/300)); }
  transition(now: number, smooth: boolean): void { const next = this.enabled ? this.gainDb : 0; this.from = smooth ? this.current(now) : next; this.target=next;this.began=now; }
  active(now: number): boolean { return now < this.began+300 && this.from !== this.target; }
  level(volume: number, duck: number, now: number): number { return Math.max(0,Math.min(1,volume))*Math.pow(10,this.current(now)/20)*Math.max(0,Math.min(1,duck)); }
}
