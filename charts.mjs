import { HISTORY_SIZE, SUBCARRIERS } from './signal.mjs';

const colors = {
  grid: '#29434d',
  label: '#a7bdc1',
  line: '#89e3cd',
  threshold: '#eeb77f',
  field: '#0f1c24',
};

function setup(canvas) {
  const { width, height } = canvas.getBoundingClientRect();
  if (!width || !height) return null;
  const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
  const pixelsWide = Math.round(width * ratio);
  const pixelsHigh = Math.round(height * ratio);
  if (canvas.width !== pixelsWide) canvas.width = pixelsWide;
  if (canvas.height !== pixelsHigh) canvas.height = pixelsHigh;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.font = '11px monospace';
  return { ctx, width, height };
}

export function drawVariation(canvas, history, threshold) {
  const drawing = setup(canvas);
  if (!drawing) return;
  const { ctx, width, height } = drawing;
  const left = 39;
  const top = 10;
  const plotWidth = width - left - 15;
  const plotHeight = height - top - 28;
  const maximum = Math.max(10, Math.ceil(Math.max(threshold ?? 0, ...history.map(row => row.score ?? 0)) / 5) * 5);
  const y = value => top + plotHeight * (1 - value / maximum);
  const x = index => left + plotWidth * (HISTORY_SIZE - history.length + index) / (HISTORY_SIZE - 1);
  ctx.fillStyle = colors.field;
  ctx.fillRect(left, top, plotWidth, plotHeight);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const fraction of [0, 0.5, 1]) {
    const value = fraction * maximum;
    const lineY = y(value);
    ctx.fillStyle = colors.label;
    ctx.fillText(String(value), left - 7, lineY);
    ctx.fillStyle = colors.grid;
    ctx.fillRect(left, lineY, plotWidth, 1);
  }
  if (threshold !== null) {
    ctx.strokeStyle = colors.threshold;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(left, y(threshold));
    ctx.lineTo(left + plotWidth, y(threshold));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.beginPath();
  let started = false;
  history.forEach((sample, index) => {
    if (sample.score === null) return;
    if (!started) ctx.moveTo(x(index), y(sample.score));
    else ctx.lineTo(x(index), y(sample.score));
    started = true;
  });
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1.8;
  ctx.stroke();
  ctx.fillStyle = colors.label;
  ctx.textAlign = 'left';
  ctx.fillText('Older', left, height - 10);
  ctx.textAlign = 'right';
  ctx.fillText('Latest', left + plotWidth, height - 10);
}

function heatColor(delta) {
  const level = Math.min(1, Math.abs(delta) * 3.1);
  const center = [28, 57, 70];
  const target = delta < 0 ? [88, 108, 234] : [255, 181, 108];
  return 'rgb(' + center.map((value, index) => Math.round(value + (target[index] - value) * level)).join(',') + ')';
}

export function drawHeatmap(canvas, history, baseline) {
  const drawing = setup(canvas);
  if (!drawing) return;
  const { ctx, width, height } = drawing;
  const left = 39;
  const top = 10;
  const plotWidth = width - left - 15;
  const plotHeight = height - top - 28;
  const column = plotWidth / HISTORY_SIZE;
  const row = plotHeight / SUBCARRIERS.length;
  ctx.fillStyle = colors.field;
  ctx.fillRect(left, top, plotWidth, plotHeight);
  if (baseline) {
    history.forEach((sample, index) => {
      if (sample.score === null) return;
      const x = left + (HISTORY_SIZE - history.length + index) * column;
      sample.shape.forEach((amplitude, bin) => {
        ctx.fillStyle = heatColor(amplitude - baseline[bin]);
        ctx.fillRect(x, top + (SUBCARRIERS.length - bin - 1) * row, column + 0.15, row + 0.15);
      });
    });
  }
  ctx.fillStyle = colors.label;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText('+26', left - 7, top + 4);
  ctx.fillText('−26', left - 7, top + plotHeight - 4);
  ctx.fillText('Latest', left + plotWidth, height - 10);
  ctx.textAlign = 'left';
  ctx.fillText('Older', left, height - 10);
}
