#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const finite = x => typeof x === 'number' && Number.isFinite(x);
const point = p => !!p && [p.x, p.y, p.z].every(finite);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const sitting = phase => [5, 6, 7].includes(phase);

/** Power five, head takes full damage; the net loss is the maximum across parts,
 * not the sum. Call only when the head dominates, with no healing/other hits/hurt cooldown. */
function damageFromDistance(d, exposure = 1) {
  if (!finite(d) || d < 0 || !finite(exposure) || exposure < 0 || exposure > 1) return null;
  if (d > 10) return 0;
  const q = (1 - d / 10) * exposure;
  return 35 * (q * q + q) + 1;
}

/** Null means no unique physical solution in [0,10]; never clamp impossible damage.
 * E=0 gives D=1 at every distance, so even D=1 cannot identify a distance then. */
function distanceFromDamage(damage, exposure = 1) {
  if (!finite(damage) || damage < 1 || !finite(exposure) || exposure <= 0 || exposure > 1) return null;
  const q = (Math.sqrt(1 + 4 * (damage - 1) / 35) - 1) / 2;
  if (q > exposure + 1e-12) return null;
  return 10 * (1 - q / exposure);
}

/** Population SD; p90 = nearest rank ceil(0.9*n), without interpolation. */
function statistics(values) {
  const a = values.filter(finite).slice().sort((a, b) => a - b), n = a.length;
  if (!n) return { n: 0, mean: null, sd: null, min: null, max: null, p90: null };
  const mean = a.reduce((s, v) => s + v, 0) / n;
  return { n, mean, sd: Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / n),
    min: a[0], max: a[n - 1], p90: a[Math.ceil(0.9 * n) - 1] };
}

function correlation(pairs) {
  const a = pairs.filter(([x, y]) => finite(x) && finite(y)), n = a.length;
  if (n < 2) return { n, r: null };
  const mx = a.reduce((s, [x]) => s + x, 0) / n, my = a.reduce((s, [, y]) => s + y, 0) / n;
  const xx = a.reduce((s, [x]) => s + (x - mx) ** 2, 0), yy = a.reduce((s, [, y]) => s + (y - my) ** 2, 0);
  return { n, r: xx && yy ? a.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / Math.sqrt(xx * yy) : null };
}

/** Timeline must prove a contiguous sitting interval and its preceding non-sitting tick.
 * perches[].startTick is phase-7 entry, which can recur within ONE sitting interval. */
function sittingStart(timeline, phase7Tick) {
  let i = timeline.findIndex(s => s.tick === phase7Tick);
  if (i < 0 || !sitting(timeline[i].phase)) return null;
  while (i > 0 && timeline[i - 1].tick === timeline[i].tick - 1 && sitting(timeline[i - 1].phase)) i--;
  return i > 0 && timeline[i - 1].tick === timeline[i].tick - 1 && !sitting(timeline[i - 1].phase) ? timeline[i].tick : null;
}

/** These receipts store seated predictedHead/headAtUse as BOX CENTRES, not feet.
 * Without the explicit seated source or matching phase7Head centre the convention is unknown. */
function predictedFeet(trial, estimate) {
  const centre = point(estimate?.predictedHead) ? estimate.predictedHead : trial.headAtUse;
  if (!point(centre)) return null;
  if (estimate?.source === 'seated_body_position_yaw') return { ...centre, y: centre.y - 0.5 };
  const pose = trial.phase7Head;
  if (point(pose?.centre) && point(pose?.feet) && distance(centre, pose.centre) < 1e-8) return { ...pose.feet };
  return null;
}

function analyseReports(reports) {
  const rows = [], counts = { files: reports.length, scenes: 0, trials: 0, detonations: 0, undetonated: 0 };
  for (const { name, report } of reports) {
    for (const scene of ['end_bed_kill', 'end_bed_crystals']) {
      const s = report.scenes?.[scene];
      if (!s) continue;
      counts.scenes++;
      const trials = s.bedTrials ?? [], detonated = trials.filter(t => finite(t.detonationTick));
      counts.trials += trials.length; counts.detonations += detonated.length; counts.undetonated += trials.length - detonated.length;
      for (const t of detonated) {
        const issues = [], perch = (s.perches ?? []).find(p => p.n === t.perch);
        // A later mutable latestEstimate is not a prediction made at use time.
        const candidate = t.prediction ?? t.latestEstimate;
        const estimate = candidate && (!finite(candidate.tick) || candidate.tick <= (t.useTick ?? t.detonationTick)) ? candidate : null;
        const feet = predictedFeet(t, estimate);
        const head = point(t.observedHalves?.head) ? t.observedHalves.head : t.head;
        const centre = point(head) ? { x: head.x + 0.5, y: head.y + 0.5, z: head.z + 0.5 } : null;
        if (!centre) issues.push('pillow_unknown');
        if (centre && point(t.explosion) && distance(centre, t.explosion) > 1e-6) issues.push('pillow_explosion_mismatch');
        if (!feet) issues.push('prediction_feet_unknown');
        const dPred = feet && centre ? distance(feet, centre) : null;
        const loss = finite(t.dragonHealthServerBefore) && finite(t.dragonHealthServerAfter)
          ? t.dragonHealthServerBefore - t.dragonHealthServerAfter : null;
        if (loss === null) issues.push('server_health_unknown');
        if (finite(t.dragonHealthServerAfter) && t.dragonHealthServerAfter <= 1) issues.push('lethal_censored');
        if (finite(t.serverBeforeTick) && finite(t.serverAfterTick) && detonated.some(other => other !== t
          && other.detonationTick >= t.serverBeforeTick && other.detonationTick <= t.serverAfterTick)) issues.push('multiple_blasts_in_health_window');
        const exposure = finite(estimate?.exposure) && estimate.exposure >= 0 && estimate.exposure <= 1 ? estimate.exposure : null;
        const dActual1 = distanceFromDamage(loss), dActualE = distanceFromDamage(loss, exposure);
        // When E is unknown only the explicitly labelled E=1 scenario is available.
        const dActual = exposure === null ? dActual1 : dActualE;
        if (loss !== null && dActual === null) issues.push('damage_not_invertible');
        const seat = sittingStart(s.phaseTimeline ?? [], perch?.startTick);
        const phase7Age = finite(perch?.startTick) ? t.detonationTick - perch.startTick : null;
        const elapsed = seat === null ? null : t.detonationTick - seat;
        const yaw = finite(perch?.body?.yaw) ? perch.body.yaw : null;
        const usable = !issues.length && dPred !== null && dActual !== null;
        rows.push({ run: name.replace(/-report\.json$/, ''), scene, trial: t.n, perch: t.perch,
          tick: t.detonationTick, seat, elapsed, phase7Age, yaw,
          // Use pre-explosion phase; phaseAtExplosion can already describe the resulting takeoff.
          phase: finite(t.phaseAtUse) ? t.phaseAtUse : null,
          loss, exposure, dPred, dActual1, dActualE, dActual,
          delta: usable ? dPred - dActual : null, issues,
          storedDistanceDifference: finite(estimate?.headDistance) && dPred !== null ? dPred - estimate.headDistance : null });
      }
    }
  }
  return { counts, rows };
}

const fmt = (v, digits = 6) => finite(v) ? v.toFixed(digits) : '不明';
function table(headers, rows) {
  return [headers, headers.map(() => '---'), ...rows].map(row =>
    `| ${row.map(cell => String(cell).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`).join('\n');
}
function groupRows(rows, key) {
  const groups = new Map();
  for (const row of rows) { const k = key(row); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(row); }
  return [...groups].map(([label, group]) => {
    const signed = statistics(group.map(r => r.delta)), abs = statistics(group.map(r => finite(r.delta) ? Math.abs(r.delta) : null));
    return [label, signed.n, fmt(signed.mean), fmt(signed.sd), fmt(signed.max), fmt(signed.p90), fmt(abs.mean), fmt(abs.p90), fmt(abs.max),
      `${group.filter(r => finite(r.delta) && r.delta < 0).length}/${group.filter(r => finite(r.delta) && r.delta > 0).length}`];
  });
}

function renderReport(result) {
  const { counts, rows } = result, valid = rows.filter(r => finite(r.delta));
  const signed = statistics(valid.map(r => r.delta)), abs = statistics(valid.map(r => Math.abs(r.delta)));
  const groups = ['群', 'n', '平均Δ', '母SD(Δ)', '最大Δ', 'p90(Δ)', '平均|Δ|', 'p90|Δ|', '最大|Δ|', '遠/近'];
  const corr = [['sin(yaw) ※phase7開始姿勢', r => finite(r.yaw) ? Math.sin(r.yaw) : null],
    ['cos(yaw) ※phase7開始姿勢', r => finite(r.yaw) ? Math.cos(r.yaw) : null],
    ['座り開始からのtick', r => r.elapsed], ['phase7開始からのtick', r => r.phase7Age]];
  const issueCounts = {};
  rows.forEach(r => r.issues.forEach(i => { issueCounts[i] = (issueCounts[i] ?? 0) + 1; }));
  const yawGroup = r => finite(r.yaw) ? `${Math.floor(((r.yaw % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 2)) * 90}–${(Math.floor(((r.yaw % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 2)) + 1) * 90}°` : '不明';
  return [
    `絶対距離残差 |Δ|: 平均 ${fmt(abs.mean)} m / p90 ${fmt(abs.p90)} m / 最大 ${fmt(abs.max)} m (n=${abs.n})。`,
    `符号付き Δ=d_pred−d_actual: 平均 ${fmt(signed.mean)} m / 母SD ${fmt(signed.sd)} m / 最小 ${fmt(signed.min)} m / 最大 ${fmt(signed.max)} m / p90 ${fmt(signed.p90)} m。`,
    `予測より遠い(Δ<0) ${valid.filter(r => r.delta < 0).length} / 近い(Δ>0) ${valid.filter(r => r.delta > 0).length} / 一致 ${valid.filter(r => r.delta === 0).length}。`,
    `入力 ${counts.files}ファイル・${counts.scenes}場面・${counts.trials}試行、起爆 ${counts.detonations}、未起爆 ${counts.undetonated}、使用 ${valid.length}、起爆除外 ${rows.length - valid.length}。`,
    `記録Eあり ${rows.filter(r => r.exposure !== null).length}、E不明 ${rows.filter(r => r.exposure === null).length}、E=1 ${rows.filter(r => r.exposure === 1).length}。除外理由 ${JSON.stringify(issueCounts)}。`,
    `yaw不明 ${rows.filter(r => r.yaw === null).length}、使用時phase不明 ${rows.filter(r => r.phase === null).length}、座り開始不明 ${rows.filter(r => r.seat === null).length}。`,
    `再計算距離と記録headDistanceの最大差 ${fmt(statistics(rows.map(r => finite(r.storedDistanceDifference) ? Math.abs(r.storedDistanceDifference) : null)).max, 9)} m。`,
    'E=1は全露出の仮定、E記録値も推定箱による値。d_actualはその条件での有効距離で、3次元位置誤差ではない。単位はm。',
    '\n### 各起爆',
    table(['r / trial / perch', 'scene', '起爆tick', '座り開始tick', '座り経過 / phase7経過', 'yaw(rad)', 'phase(使用)', 'サーバーΔHP', 'E', 'd_pred', 'd_actual(E=1)', 'd_actual(E記録)', 'Δ(記録E優先)', '除外理由'], rows.map(r =>
      [`${r.run} / ${r.trial} / ${r.perch}`, r.scene, r.tick, r.seat ?? '不明', `${r.elapsed ?? '不明'} / ${r.phase7Age ?? '不明'}`, fmt(r.yaw), r.phase ?? '不明', fmt(r.loss), fmt(r.exposure), fmt(r.dPred), fmt(r.dActual1), fmt(r.dActualE), fmt(r.delta), r.issues.join(',') || '—'])),
    '\n### 全体・r番号ごと', table(groups, [...groupRows(rows, () => '全体'), ...groupRows(rows, r => r.run)]),
    '\n### 座りごと（連続するphase 5/6/7。perch番号はphase7への再入場で増える）',
    table(groups, groupRows(rows, r => `${r.run}/${r.scene}/座り@${r.seat ?? `不明-perch${r.perch}`}`)),
    '\n### phase・yaw・経過tickごと',
    table(groups, [...groupRows(rows, r => `phase ${r.phase ?? '不明'}`), ...groupRows(rows, r => `yaw ${yawGroup(r)}`),
      ...groupRows(rows, r => r.elapsed === null ? '座りtick 不明' : `座りtick ${Math.floor(r.elapsed / 200) * 200}–${Math.floor(r.elapsed / 200) * 200 + 199}`)]),
    '\n### 符号付き残差とのPearson相関（yawは周期を保つsin/cosで比較）',
    table(['変数', 'n', 'r'], corr.map(([label, x]) => { const c = correlation(valid.map(r => [x(r), r.delta])); return [label, c.n, fmt(c.r)]; })),
  ].join('\n\n') + '\n';
}

module.exports = { damageFromDistance, distanceFromDamage, statistics, correlation, sittingStart, predictedFeet, analyseReports, renderReport };

if (require.main === module) {
  // Fixed relative to this script, independent of cwd; reads only lab-evidence.
  const directory = path.resolve(__dirname, '../../../lab-evidence');
  const names = fs.readdirSync(directory).filter(n => /^r2.*-report\.json$/.test(n)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const reports = names.map(name => ({ name, report: JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) }));
  if (!reports.length) throw new Error('No lab-evidence/r2*-report.json files');
  process.stdout.write(renderReport(analyseReports(reports)));
}
