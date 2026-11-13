import { CALIBRATION_SAMPLES, frameReader, LinkAnalyzer, simulatedFrame } from './signal.mjs';
import { drawHeatmap, drawVariation } from './charts.mjs';
import { Trial, TRIAL_SAMPLES } from './trials.mjs';

const byId = id => document.getElementById(id);
const analyzer = new LinkAnalyzer();
const trialResults = { a: null, b: null };
let activeTrial = null;
let source = 'simulation';
let sampleTime = 0;
let pending = false;
let session = null;
let lastSampleAt = -Infinity;
let lastFrameTime = null;
let displayFrame = 0;
const supportsSerial = 'serial' in navigator;

function updateText(id, value) {
  const node = byId(id);
  if (node.textContent !== value) node.textContent = value;
}

function signalStale() {
  return source === 'live' && (!session || performance.now() - lastSampleAt > 2500);
}

function render() {
  displayFrame = 0;
  const { baseline, threshold, changed, history, samples } = analyzer;
  const newest = history.at(-1);
  const stale = signalStale();
  if (stale && activeTrial) cancelTrial('Trial cancelled because the signal stopped.');
  const state = stale ? (session ? 'Waiting for samples' : 'Disconnected')
    : !baseline ? 'Calibrating' : changed ? 'Link changed' : 'Within baseline';
  updateText('state', state);
  byId('state').className = !stale && baseline ? (changed ? 'changed' : 'stable') : '';
  updateText('score', !stale && newest?.score != null ? newest.score.toFixed(1) : '—');
  updateText('threshold', threshold !== null ? threshold.toFixed(1) : '—');
  updateText('rssi', !stale && newest ? newest.rssi + ' dBm' : '—');
  const sampleCount = samples.length;
  updateText('baseline-status', baseline ? 'Baseline ready · ' + CALIBRATION_SAMPLES + ' samples'
    : 'Keep the setup still · ' + sampleCount + ' / ' + CALIBRATION_SAMPLES + ' samples');
  byId('calibration').value = sampleCount;
  byId('export').disabled = !history.length;
  const recording = Boolean(activeTrial);
  const canRecord = Boolean(baseline) && !stale && !pending && !recording;
  byId('record-a').disabled = !canRecord;
  byId('record-b').disabled = !canRecord;
  byId('connect').disabled = pending || recording || !supportsSerial || Boolean(session?.stopping);
  byId('clear-trials').disabled = recording || (!trialResults.a && !trialResults.b);
  byId('cancel-trial').hidden = !recording;
  byId('trial-progress').hidden = !recording;
  byId('trial-progress').value = activeTrial?.trial.count ?? 0;
  byId('motion').disabled = recording;
  byId('loss').disabled = recording;
  byId('calibrate').disabled = pending || (source === 'live' && !session) || recording;
  drawVariation(byId('variation'), history, threshold);
  drawHeatmap(byId('heatmap'), history, baseline);
}

function scheduleRender() {
  if (!displayFrame) displayFrame = requestAnimationFrame(render);
}

function updateControls() {
  const live = source === 'live';
  updateText('source', live ? 'ESP32 USB' : 'Simulation');
  byId('source').classList.toggle('live', live);
  byId('simulation-controls').hidden = live;
  byId('simulation').hidden = !live;
  byId('simulation').disabled = pending || Boolean(session);
  updateText('connect', pending ? 'Opening USB port…' : session ? 'Disconnect ESP32' : 'Connect ESP32');
  scheduleRender();
}

function clearCredentials() {
  byId('password').value = '';
  byId('show-password').checked = false;
  byId('password').type = 'password';
  byId('network').hidden = true;
}

function startSimulation() {
  source = 'simulation';
  analyzer.reset();
  clearTrials();
  lastFrameTime = null;
  byId('motion').checked = true;
  sampleTime = 0;
  const loss = Number(byId('loss').value);
  for (let index = 0; index < 110; index += 1) {
    analyzer.push(simulatedFrame(sampleTime, index >= 73, loss));
    sampleTime += 100;
  }
  clearCredentials();
  updateText('device-status', supportsSerial ? 'Connect a flashed board over USB for live CSI samples.'
    : 'USB capture requires a desktop browser with Web Serial support.');
  updateControls();
}

function receive(frame) {
  if (activeTrial && signalStale()) cancelTrial('Trial cancelled because the signal stopped.');
  if (lastFrameTime !== null && frame.time < lastFrameTime) {
    analyzer.reset();
    cancelTrial('The board restarted. Wait for a new baseline.');
  }
  lastFrameTime = frame.time;
  if (collect(frame)) lastSampleAt = performance.now();
  scheduleRender();
}

function showTrialResult(slot) {
  const value = trialResults[slot];
  const readings = byId('result-' + slot);
  readings.replaceChildren();
  readings.hidden = !value;
  updateText('condition-' + slot, value?.condition ?? 'No recording');
  if (!value) return;
  const fields = [
    ['Mean variation', value.average.toFixed(1)],
    ['Peak variation', value.peak.toFixed(1)],
    ['Above threshold', value.over + ' / ' + TRIAL_SAMPLES],
    ['Threshold', value.threshold.toFixed(1)],
    ['Sample span', (value.elapsedMs / 1000).toFixed(1) + ' s'],
  ];
  for (const [label, reading] of fields) {
    const pair = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = label;
    const definition = document.createElement('dd');
    definition.textContent = reading;
    pair.append(term, definition);
    readings.append(pair);
  }
}

function clearTrials() {
  activeTrial = null;
  trialResults.a = null;
  trialResults.b = null;
  showTrialResult('a');
  showTrialResult('b');
  updateText('trial-status', 'Choose a condition and record Trial A.');
  scheduleRender();
}

function cancelTrial(message) {
  if (!activeTrial) return;
  activeTrial = null;
  updateText('trial-status', message);
  scheduleRender();
}

function recordTrial(slot) {
  if (!analyzer.baseline || signalStale() || pending || activeTrial) return;
  const condition = source === 'live' ? 'ESP32 USB' :
    'Simulation · ' + byId('loss').value + ' dB · movement ' + (byId('motion').checked ? 'on' : 'off');
  activeTrial = { slot, trial: new Trial(analyzer.threshold, condition) };
  updateText('trial-status', 'Recording Trial ' + slot.toUpperCase() + '.');
  scheduleRender();
}

function collect(frame) {
  const sample = analyzer.push(frame);
  if (!sample) return false;
  if (!activeTrial) return true;
  const { slot, trial } = activeTrial;
  const result = trial.push(sample);
  if (!result) return true;
  activeTrial = null;
  trialResults[slot] = result;
  showTrialResult(slot);
  updateText('trial-status', trialResults.a && trialResults.b
    ? 'Both trials are ready to compare.'
    : 'Trial ' + slot.toUpperCase() + ' saved. Choose the second condition.');
  return true;
}

function controlLine(line) {
  const match = /^LAB1,([0-9a-f]{12})$/.exec(line);
  if (match) {
    byId('password').value = match[1];
    byId('network').hidden = false;
  }
  if (line === 'ERR1,UDP listener unavailable') {
    updateText('device-status', 'The board could not open its probe listener. Restart the board.');
  }
}

async function connect() {
  pending = true;
  updateControls();
  let port;
  let opened = false;
  let disconnected = false;
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200, bufferSize: 8192 });
    opened = true;
    session = { reader: port.readable.getReader(), stopping: false };
    pending = false;
    source = 'live';
    analyzer.reset();
    clearTrials();
    lastSampleAt = -Infinity;
    lastFrameTime = null;
    updateText('device-status', 'USB connected. Waiting for the board’s lab network and CSI samples.');
    updateControls();
    const decode = new TextDecoder();
    const ingest = frameReader(receive, controlLine);
    while (!session.stopping) {
      const { value, done } = await session.reader.read();
      if (done) break;
      if (value && !session.stopping) ingest(decode.decode(value, { stream: true }));
    }
    disconnected = true;
  } catch (error) {
    if (opened) updateText('device-status', 'USB connection ended. Reconnect the board to resume.');
    else if (error.name === 'NotFoundError') updateText('device-status', 'No USB port selected.');
    else updateText('device-status', 'Could not open the USB port. Close any serial monitor and try again.');
  } finally {
    if (session) session.stopping = true;
    updateControls();
    session?.reader.releaseLock();
    if (opened) await port.close().catch(() => {});
    session = null;
    pending = false;
    if (opened) cancelTrial('Trial cancelled because USB disconnected.');
    clearCredentials();
    if (disconnected) updateText('device-status', 'USB disconnected.');
    updateControls();
  }
}

function exportMetrics() {
  const first = analyzer.history[0]?.time;
  if (first === undefined) return;
  const rows = analyzer.history.map(sample => [
    source === 'simulation' ? 'simulation' : 'esp32',
    sample.time - first,
    sample.rssi,
    sample.score?.toFixed(3) ?? '',
    sample.score === null ? '' : analyzer.threshold.toFixed(3),
    sample.score === null ? 'calibrating' : sample.changed ? 'changed' : 'baseline',
  ].join(','));
  const csv = ['source,elapsed_ms,rssi_dbm,variation_score,threshold_score,link_state', ...rows].join('\n') + '\n';
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'wifi-csi-metrics.csv';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

byId('loss').addEventListener('input', () => updateText('loss-value', byId('loss').value + ' dB'));
byId('calibrate').addEventListener('click', () => {
  if (activeTrial) return;
  analyzer.reset();
  if (source === 'simulation') byId('motion').checked = false;
  scheduleRender();
});
byId('show-password').addEventListener('change', () => {
  byId('password').type = byId('show-password').checked ? 'text' : 'password';
});
byId('connect').addEventListener('click', () => {
  if (pending || activeTrial || session?.stopping) return;
  if (!session) {
    connect();
    return;
  }
  session.stopping = true;
  updateControls();
  session.reader.cancel().catch(() => {});
});
byId('simulation').addEventListener('click', startSimulation);
byId('export').addEventListener('click', exportMetrics);
byId('record-a').addEventListener('click', () => recordTrial('a'));
byId('record-b').addEventListener('click', () => recordTrial('b'));
byId('cancel-trial').addEventListener('click', () => cancelTrial('Trial cancelled.'));
byId('clear-trials').addEventListener('click', clearTrials);
const resize = new ResizeObserver(scheduleRender);
resize.observe(byId('variation'));
resize.observe(byId('heatmap'));
setInterval(() => {
  if (source === 'simulation') {
    collect(simulatedFrame(sampleTime, byId('motion').checked, Number(byId('loss').value)));
    sampleTime += 100;
  }
  scheduleRender();
}, 100);
startSimulation();
