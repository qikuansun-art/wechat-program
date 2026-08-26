'use strict';

const fs = require('fs');

function buildPairKey(memberIds) {
  return memberIds.slice().sort().join('|');
}

function candidateFromParticipants(record) {
  if (record && record.creatorId && record.partnerId && record.creatorId !== record.partnerId) {
    const memberIds = [record.creatorId, record.partnerId].sort();
    return { status: 'CANDIDATE', pairKey: buildPairKey(memberIds), memberIds };
  }
  return { status: 'MANUAL_REVIEW', reason: 'missing creatorId/partnerId' };
}

function analyzeMigration(input) {
  const data = input || {};
  const schedulesById = new Map();
  const result = { bills: [], reports: [], schedules: [], schedule_completions: [] };

  (data.bills || []).forEach((record) => {
    result.bills.push(Object.assign({ _id: record._id }, record.pairKey
      ? { status: 'ALREADY_MIGRATED', pairKey: record.pairKey }
      : candidateFromParticipants(record)));
  });
  (data.reports || []).forEach((record) => {
    result.reports.push(Object.assign({ _id: record._id }, record.pairKey
      ? { status: 'ALREADY_MIGRATED', pairKey: record.pairKey }
      : candidateFromParticipants(record)));
  });
  (data.schedules || []).forEach((record) => {
    const analysis = record.pairKey
      ? { status: 'ALREADY_MIGRATED', pairKey: record.pairKey }
      : { status: 'MANUAL_REVIEW', reason: 'historical schedule has no partnerId; current partner must not be used' };
    schedulesById.set(record._id, analysis);
    result.schedules.push(Object.assign({ _id: record._id }, analysis));
  });
  (data.schedule_completions || []).forEach((record) => {
    const parent = schedulesById.get(record.scheduleId);
    let analysis;
    if (record.pairKey) analysis = { status: 'ALREADY_MIGRATED', pairKey: record.pairKey };
    else if (parent && parent.pairKey) analysis = { status: 'CANDIDATE', pairKey: parent.pairKey, source: 'parent_schedule' };
    else analysis = { status: 'MANUAL_REVIEW', reason: parent ? 'parent schedule pairKey is uncertain' : 'parent schedule not found' };
    result.schedule_completions.push(Object.assign({ _id: record._id }, analysis));
  });
  return result;
}

function summarize(result) {
  const summary = {};
  Object.keys(result).forEach((collection) => {
    summary[collection] = result[collection].reduce((counts, item) => {
      counts[item.status] = (counts[item.status] || 0) + 1;
      return counts;
    }, {});
  });
  return summary;
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.log('Usage: node scripts/audit_pairkey_migration.js <local-export.json>');
    console.log('Read-only dry-run: this script never connects to cloud database and never writes data.');
  } else {
    const input = JSON.parse(fs.readFileSync(file, 'utf8'));
    const result = analyzeMigration(input);
    console.log(JSON.stringify({ summary: summarize(result), records: result }, null, 2));
  }
}

module.exports = { buildPairKey, candidateFromParticipants, analyzeMigration, summarize };
