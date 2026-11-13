export const TRIAL_SAMPLES = 60;

export class Trial {
  constructor(threshold, condition) {
    this.threshold = threshold;
    this.condition = condition;
    this.count = 0;
    this.sum = 0;
    this.peak = 0;
    this.over = 0;
    this.firstTime = null;
  }

  push(sample) {
    if (sample.score === null || this.count === TRIAL_SAMPLES) return null;
    this.firstTime ??= sample.time;
    this.count += 1;
    this.sum += sample.score;
    this.peak = Math.max(this.peak, sample.score);
    if (sample.score > this.threshold) this.over += 1;
    if (this.count < TRIAL_SAMPLES) return null;
    return {
      condition: this.condition,
      average: this.sum / this.count,
      peak: this.peak,
      over: this.over,
      threshold: this.threshold,
      elapsedMs: sample.time - this.firstTime,
    };
  }
}
