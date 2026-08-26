'use strict';

// Local-only migration dry-run. Intentionally has no wx-server-sdk dependency.
const fs = require('fs');
const path = require('path');
const MIGRATION_COLLECTIONS = ['bills', 'reports', 'schedules', 'schedule_completions'];
const AUDIT_COLLECTIONS = ['bill_budgets', 'couple_settings'];

function buildPairKey(memberIds) { return memberIds.slice().sort().join('|'); }
function unwrapRecords(payload, sourceName) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && Array.isArray(payload.records)) return payload.records;
  throw new Error(`${sourceName || 'input'} must be [], { data: [] }, or { records: [] }`);
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function loadInputDirectory(inputDir) {
  const result = {};
  [...MIGRATION_COLLECTIONS, ...AUDIT_COLLECTIONS, 'users'].forEach((name) => {
    const file = path.join(inputDir, `${name}.json`);
    result[name] = fs.existsSync(file) ? unwrapRecords(readJson(file), file) : [];
  });
  return result;
}

function validateConfig(config) {
  const warnings = [];
  const pairByKey = new Map();
  const pairByUser = new Map();
  let patchBlocked = false;
  (config.knownPairs || []).forEach((entry, index) => {
    const memberIds = Array.isArray(entry.memberIds) ? entry.memberIds.map(String) : [];
    const canonical = memberIds.length === 2 && memberIds[0] !== memberIds[1] ? buildPairKey(memberIds) : '';
    if (!canonical || entry.pairKey !== canonical) {
      warnings.push({ code: 'INVALID_KNOWN_PAIR', index, pairKey: entry.pairKey || '', message: 'knownPair must contain two distinct members and a stable sorted pairKey' });
      patchBlocked = true;
      return;
    }
    if (pairByKey.has(canonical)) {
      warnings.push({ code: 'DUPLICATE_KNOWN_PAIR', index, pairKey: canonical, message: 'knownPair is duplicated' });
      patchBlocked = true;
      return;
    }
    pairByKey.set(canonical, { pairKey: canonical, memberIds: memberIds.slice().sort() });
    memberIds.forEach((userId) => {
      if (pairByUser.has(userId) && pairByUser.get(userId) !== canonical) {
        warnings.push({ code: 'USER_IN_MULTIPLE_KNOWN_PAIRS', userId, pairKeys: [pairByUser.get(userId), canonical], message: 'one user appears in multiple active knownPairs' });
        patchBlocked = true;
      } else pairByUser.set(userId, canonical);
    });
  });
  const ownership = config.legacyScheduleOwnership || {};
  Object.keys(ownership).forEach((creatorId) => {
    const pairKey = String(ownership[creatorId] || '');
    const pair = pairByKey.get(pairKey);
    if (!pair || !pair.memberIds.includes(creatorId)) {
      warnings.push({ code: 'INVALID_SCHEDULE_OWNERSHIP', creatorId, pairKey, message: 'legacyScheduleOwnership must reference a knownPair containing the creator' });
      patchBlocked = true;
    }
  });
  return { warnings, pairByKey, pairByUser, ownership, patchBlocked };
}

function warnExistingPair(collection, record, warnings) {
  if (record.pairKey && (!Array.isArray(record.memberIds) || buildPairKey(record.memberIds.map(String)) !== record.pairKey)) {
    warnings.push({ code: 'PAIRKEY_MEMBERIDS_MISMATCH', collection, _id: record._id, pairKey: record.pairKey, memberIds: record.memberIds || null });
  }
}
function classifyParticipants(collection, record, state, warnings) {
  if (record.pairKey) {
    warnExistingPair(collection, record, warnings);
    return { _id: record._id, status: 'ALREADY_MIGRATED', candidatePairKey: record.pairKey, reason: 'pairKey already exists' };
  }
  if (!record.creatorId || !record.partnerId || record.creatorId === record.partnerId) {
    return { _id: record._id, status: 'MANUAL_REVIEW', reason: 'missing or invalid creatorId/partnerId' };
  }
  const memberIds = [String(record.creatorId), String(record.partnerId)].sort();
  const candidatePairKey = buildPairKey(memberIds);
  if (!state.pairByKey.has(candidatePairKey)) {
    return { _id: record._id, status: 'MANUAL_REVIEW', candidatePairKey, reason: 'record participants did not match knownPairs' };
  }
  return { _id: record._id, status: 'AUTO_SAFE', candidatePairKey, memberIds, reason: 'creatorId+partnerId matched knownPairs' };
}
function classifySchedule(record, state, warnings) {
  if (record.pairKey) {
    warnExistingPair('schedules', record, warnings);
    return { _id: record._id, status: 'ALREADY_MIGRATED', candidatePairKey: record.pairKey, reason: 'pairKey already exists' };
  }
  const candidatePairKey = state.ownership[record.creatorId];
  const pair = candidatePairKey && state.pairByKey.get(candidatePairKey);
  if (!pair) return { _id: record._id, status: 'MANUAL_REVIEW', reason: 'no explicit legacyScheduleOwnership for creatorId' };
  if (!pair.memberIds.includes(String(record.creatorId))) {
    warnings.push({ code: 'SCHEDULE_CREATOR_NOT_IN_CANDIDATE_PAIR', collection: 'schedules', _id: record._id, creatorId: record.creatorId, candidatePairKey });
    return { _id: record._id, status: 'MANUAL_REVIEW', reason: 'schedule creator is not in configured pair' };
  }
  return { _id: record._id, status: 'AUTO_SAFE', candidatePairKey, memberIds: pair.memberIds, reason: 'explicit legacyScheduleOwnership matched knownPairs' };
}

function auditExistingCollections(data, warnings) {
  const budgets = new Map();
  (data.bill_budgets || []).forEach((record) => {
    if (!record.pairKey) warnings.push({ code: 'MISSING_PAIRKEY', collection: 'bill_budgets', _id: record._id });
    else warnExistingPair('bill_budgets', record, warnings);
    const key = `${record.pairKey || ''}|${record.month || ''}`;
    if (budgets.has(key)) warnings.push({ code: 'DUPLICATE_PAIR_MONTH_BUDGET', collection: 'bill_budgets', _id: record._id, duplicateOf: budgets.get(key), pairKey: record.pairKey, month: record.month });
    else budgets.set(key, record._id);
  });
  const settings = new Map();
  (data.couple_settings || []).forEach((record) => {
    if (!record.pairKey) warnings.push({ code: 'MISSING_PAIRKEY', collection: 'couple_settings', _id: record._id });
    else warnExistingPair('couple_settings', record, warnings);
    if (record.pairKey && settings.has(record.pairKey)) warnings.push({ code: 'DUPLICATE_COUPLE_SETTINGS', collection: 'couple_settings', _id: record._id, duplicateOf: settings.get(record.pairKey), pairKey: record.pairKey });
    else if (record.pairKey) settings.set(record.pairKey, record._id);
  });
}
function emptyBuckets() { return MIGRATION_COLLECTIONS.reduce((o, name) => { o[name] = []; return o; }, {}); }

function analyzeMigration(input, config) {
  const data = input || {};
  const state = validateConfig(config || {});
  const warnings = state.warnings.slice();
  const records = emptyBuckets();
  const schedulesById = new Map();
  (data.bills || []).forEach((r) => records.bills.push(classifyParticipants('bills', r, state, warnings)));
  (data.reports || []).forEach((r) => records.reports.push(classifyParticipants('reports', r, state, warnings)));
  (data.schedules || []).forEach((r) => {
    const analysis = classifySchedule(r, state, warnings);
    records.schedules.push(analysis);
    schedulesById.set(r._id, analysis);
  });
  (data.schedule_completions || []).forEach((record) => {
    let analysis;
    if (record.pairKey) {
      analysis = { _id: record._id, status: 'ALREADY_MIGRATED', candidatePairKey: record.pairKey, reason: 'pairKey already exists' };
    } else {
      const parent = schedulesById.get(record.scheduleId);
      if (parent && (parent.status === 'AUTO_SAFE' || parent.status === 'ALREADY_MIGRATED')) {
        analysis = { _id: record._id, status: 'AUTO_SAFE', candidatePairKey: parent.candidatePairKey, reason: 'inherited from verified parent schedule' };
      } else analysis = { _id: record._id, status: 'MANUAL_REVIEW', reason: parent ? 'parent schedule requires manual review' : 'parent schedule not found' };
      if (!parent) warnings.push({ code: 'COMPLETION_PARENT_NOT_FOUND', collection: 'schedule_completions', _id: record._id, scheduleId: record.scheduleId });
    }
    records.schedule_completions.push(analysis);
  });
  auditExistingCollections(data, warnings);

  const autoSafe = emptyBuckets(), manualReview = emptyBuckets(), alreadyMigrated = emptyBuckets(), summary = {};
  MIGRATION_COLLECTIONS.forEach((name) => {
    records[name].forEach((item) => {
      if (item.status === 'AUTO_SAFE') autoSafe[name].push(item);
      else if (item.status === 'MANUAL_REVIEW') manualReview[name].push(item);
      else alreadyMigrated[name].push(item);
    });
    summary[name] = { total: records[name].length, alreadyMigrated: alreadyMigrated[name].length, autoSafe: autoSafe[name].length, manualReview: manualReview[name].length };
  });
  summary.bill_budgets = { total: (data.bill_budgets || []).length };
  summary.couple_settings = { total: (data.couple_settings || []).length };
  const report = { summary, autoSafe, manualReview, alreadyMigrated, warnings, patchBlocked: state.patchBlocked };
  const patch = emptyBuckets();
  if (!state.patchBlocked) MIGRATION_COLLECTIONS.forEach((name) => autoSafe[name].forEach((item) => {
    const set = { pairKey: item.candidatePairKey };
    if (name !== 'schedule_completions') set.memberIds = state.pairByKey.get(item.candidatePairKey).memberIds;
    patch[name].push({ _id: item._id, set });
  }));
  return { report, patch };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || !argv[i + 1]) throw new Error('arguments must use --name value');
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}
function printSummary(report) {
  console.log('PairKey migration dry-run (local files only)');
  MIGRATION_COLLECTIONS.forEach((name) => {
    const item = report.summary[name];
    console.log(`${name}: total=${item.total} already=${item.alreadyMigrated} autoSafe=${item.autoSafe} manualReview=${item.manualReview}`);
  });
  console.log(`warnings=${report.warnings.length} patchBlocked=${report.patchBlocked}`);
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.input || !args.config || !args.report || !args.patch) throw new Error('Usage: node scripts/audit_pairkey_migration.js --input <dir> --config <json> --report <json> --patch <json>');
    const output = analyzeMigration(loadInputDirectory(path.resolve(args.input)), readJson(path.resolve(args.config)));
    fs.writeFileSync(path.resolve(args.report), JSON.stringify(output.report, null, 2) + '\n', 'utf8');
    if (output.report.patchBlocked) {
      console.error('Patch generation refused because migration config has conflicts. Report was written; patch was not written.');
      process.exitCode = 2;
    } else fs.writeFileSync(path.resolve(args.patch), JSON.stringify(output.patch, null, 2) + '\n', 'utf8');
    printSummary(output.report);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { buildPairKey, unwrapRecords, loadInputDirectory, validateConfig, analyzeMigration, parseArgs };
