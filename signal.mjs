export const SUBCARRIERS = [
  ...Array.from({ length: 26 }, (_, index) => index - 26),
  ...Array.from({ length: 25 }, (_, index) => index + 2),
];
export const CALIBRATION_SAMPLES = 48;
export const HISTORY_SIZE = 120;
const SAMPLE_BYTES = 128;

export function parseFrame(line) {
  if (typeof line !== 'string' || line.length > 800 || !line.startsWith('CSI1,')) return null;
  const parts = line.trim().split(',');
  if (parts.length !== SAMPLE_BYTES + 3 || parts.slice(1).some(value => !/^-?\d+$/.test(value))) return null;
  const [time, rssi, ...iq] = parts.slice(1).map(Number);
  if (!Number.isSafeInteger(time) || time < 0 || rssi < -127 || rssi > 0
    || iq.some(value => value < -128 || value > 127)) return null;
  const amplitude = SUBCARRIERS.map(bin => {
    const index = 2 * (bin < 0 ? bin + 64 : bin);
    return Math.hypot(iq[index], iq[index + 1]);
  });
  return { time, rssi, amplitude };
}

// UART chunks can split a line at any byte. Ignore oversized lines until the next newline.
export function frameReader(onFrame, onControl) {
  let line = '';
  let discarding = false;
  return chunk => {
    for (const character of chunk) {
      if (character === '\n') {
        if (!discarding) {
          const frame = parseFrame(line);
          if (frame) onFrame(frame);
          else onControl?.(line.trim());
        }
        line = '';
        discarding = false;
      } else if (!discarding) {
        line += character;
        if (line.length > 800) {
          line = '';
          discarding = true;
        }
      }
    }
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalize(amplitude) {
  const mean = amplitude.reduce((total, value) => total + value, 0) / amplitude.length;
  return mean > 0 ? amplitude.map(value => value / mean) : null;
}

function distance(sample, baseline) {
  const squared = sample.reduce((total, value, index) => total + (value - baseline[index]) ** 2, 0);
  return 100 * Math.sqrt(squared / sample.length);
}

export class LinkAnalyzer {
  constructor() {
    this.reset();
  }

  reset() {
    this.samples = [];
    this.baseline = null;
    this.threshold = null;
    this.history = [];
    this.high = 0;
    this.low = 0;
    this.changed = false;
  }

  push(frame) {
    const shape = normalize(frame.amplitude);
    if (!shape) return;
    if (!this.baseline) {
      this.samples.push(shape);
      if (this.samples.length === CALIBRATION_SAMPLES) {
        this.baseline = SUBCARRIERS.map((_, index) => median(this.samples.map(row => row[index])));
        const distances = this.samples.map(sample => distance(sample, this.baseline));
        const center = median(distances);
        const mad = median(distances.map(value => Math.abs(value - center)));
        this.threshold = center + Math.max(3, 7 * 1.4826 * mad);
      }
    }
    const score = this.baseline ? distance(shape, this.baseline) : null;
    if (score !== null) {
      this.high = score > this.threshold ? this.high + 1 : 0;
      this.low = score < this.threshold * 0.75 ? this.low + 1 : 0;
      if (this.high >= 3) this.changed = true;
      if (this.low >= 4) this.changed = false;
    }
    const sample = { time: frame.time, rssi: frame.rssi, shape, score, changed: this.changed };
    this.history.push(sample);
    if (this.history.length > HISTORY_SIZE) this.history.shift();
    return sample;
  }
}

// Baseband magnitudes from a direct path, a fixed reflection, and an optional moving reflection.
export function simulatedFrame(time, moving, wallLossDb) {
  const carrierHz = 2.437e9;
  const spacingHz = 312_500;
  const speedOfLight = 299_792_458;
  const reflection = moving ? 0.46 * 10 ** (-wallLossDb / 20) : 0;
  const path = 2.4 + 0.17 * Math.sin(time / 480) + 0.08 * Math.cos(time / 750);
  const amplitude = SUBCARRIERS.map(bin => {
    const frequency = carrierHz + bin * spacingHz;
    const angle = distanceMeters => 2 * Math.PI * frequency * distanceMeters / speedOfLight;
    const fixed = angle(11.8);
    const second = angle(24.7);
    const motion = angle(path + 17.4);
    const inPhase = 1 + 0.46 * Math.cos(fixed) + 0.22 * Math.cos(second) + reflection * Math.cos(motion);
    const quadrature = 0.46 * Math.sin(fixed) + 0.22 * Math.sin(second) + reflection * Math.sin(motion);
    const jitter = 0.012 * Math.sin(time / 37 + bin * 4.13) + 0.009 * Math.cos(time / 91 - bin * 7.32);
    return Math.hypot(inPhase, quadrature) + jitter;
  });
  const power = amplitude.reduce((total, value) => total + value ** 2, 0) / amplitude.length;
  return { time, rssi: Math.round(-53 + 10 * Math.log10(power)), amplitude };
}
