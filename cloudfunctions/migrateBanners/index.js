// 一次性迁移工具：把当前情侣双方一致的 users.banners 引用迁到 couple_settings.banners。
// 不复制、不移动、不删除任何云存储文件。
const crypto = require('crypto');
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const CLOUD_FILE_ID_PATTERN = /^cloud:\/\/[^/\s]+\/.+/;
class BusinessError extends Error {
  constructor(message, code) { super(message); this.name = 'BusinessError'; this.code = code; }
}
function sameOrderedList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function pairInfo(me, partner) {
  const memberIds = [me._id, partner._id].sort();
  const pairKey = memberIds.join('|');
  return { memberIds, pairKey, documentId: crypto.createHash('sha256').update(pairKey).digest('hex') };
}
async function getCurrentPair(openid) {
  if (!openid) return { error: { success: false, code: 'NO_OPENID', msg: '当前调用环境缺少 OPENID' } };
  const users = db.collection('users');
  const meRes = await users.where({ openid }).get();
  if (meRes.data.length !== 1) return { error: { success: false, code: 'USER_NOT_FOUND', msg: '当前用户不存在' } };
  const me = meRes.data[0];
  if (!me.partnerId) return { error: { success: false, code: 'NOT_BOUND', msg: '当前用户未绑定伴侣' } };
  const partnerRes = await users.doc(me.partnerId).get().catch(() => null);
  const partner = partnerRes && partnerRes.data;
  if (!partner) return { error: { success: false, code: 'PARTNER_NOT_FOUND', msg: '伴侣不存在' } };
  if (partner.partnerId !== me._id) return { error: { success: false, code: 'BINDING_INVALID', msg: '双方不是双向绑定' } };
  return Object.assign({ me, partner }, pairInfo(me, partner));
}
function inspect(me, partner, settings, pair) {
  const mine = Array.isArray(me.banners) ? me.banners.slice() : [];
  const theirs = Array.isArray(partner.banners) ? partner.banners.slice() : [];
  const target = settings && Array.isArray(settings.banners) ? settings.banners.slice() : [];
  const errors = [];
  if (settings && settings.pairKey !== pair.pairKey) errors.push({ code: 'SETTINGS_CONFLICT', msg: '目标情侣设置归属异常' });
  const alreadyMigrated = target.length > 0;
  if (!alreadyMigrated && !sameOrderedList(mine, theirs)) errors.push({ code: 'BANNER_HISTORY_CONFLICT', msg: '双方历史 Banner 数据不一致' });
  if (!alreadyMigrated && !mine.every((fileID) => typeof fileID === 'string' && CLOUD_FILE_ID_PATTERN.test(fileID))) {
    errors.push({ code: 'INVALID_FILE_ID', msg: '历史 Banner 中存在不合法 fileID' });
  }
  return {
    sourceCount: mine.length,
    targetCount: target.length,
    alreadyMigrated,
    toMigrate: errors.length === 0 && !alreadyMigrated && mine.length > 0 ? 1 : 0,
    errors
  };
}

exports.main = async (event = {}) => {
  const mode = event.mode === 'apply' ? 'apply' : 'dryRun';
  const { OPENID } = cloud.getWXContext();
  try {
    if (mode === 'apply' && event.confirm !== 'MIGRATE_BANNERS') {
      return { success: false, mode, code: 'CONFIRM_REQUIRED', msg: '缺少 Banner 迁移确认口令' };
    }
    const pair = await getCurrentPair(OPENID);
    if (pair.error) return Object.assign({ mode }, pair.error);
    const settingsRef = db.collection('couple_settings').doc(pair.documentId);
    const settingsRes = await settingsRef.get().catch(() => null);
    const before = inspect(pair.me, pair.partner, settingsRes && settingsRes.data, pair);
    if (before.errors.length) return { success: false, mode, code: before.errors[0].code, pairKey: pair.pairKey, summary: before, errors: before.errors };
    if (mode === 'dryRun' || before.alreadyMigrated || before.toMigrate === 0) {
      return { success: true, mode, pairKey: pair.pairKey, migrated: 0, summary: before, errors: [] };
    }

    let migrated = 0;
    await db.runTransaction(async (transaction) => {
      const meRes = await transaction.collection('users').doc(pair.me._id).get();
      const partnerRes = await transaction.collection('users').doc(pair.partner._id).get();
      const me = meRes && meRes.data, partner = partnerRes && partnerRes.data;
      if (!me || !partner || me.openid !== OPENID || me.partnerId !== partner._id || partner.partnerId !== me._id) {
        throw new BusinessError('迁移期间绑定关系发生变化', 'BINDING_INVALID');
      }
      const freshPair = pairInfo(me, partner);
      const ref = transaction.collection('couple_settings').doc(freshPair.documentId);
      const targetRes = await ref.get().catch(() => null);
      const target = targetRes && targetRes.data;
      const checked = inspect(me, partner, target, freshPair);
      if (checked.errors.length) throw new BusinessError(checked.errors[0].msg, checked.errors[0].code);
      if (checked.alreadyMigrated || checked.toMigrate === 0) return;
      const banners = Array.isArray(me.banners) ? me.banners.slice() : [];
      const now = db.serverDate();
      if (target) await ref.update({ data: { banners, updatedAt: now, updatedBy: me._id } });
      else await ref.set({ data: { pairKey: freshPair.pairKey, memberIds: freshPair.memberIds, banners, createdAt: now, updatedAt: now, updatedBy: me._id } });
      migrated = 1;
    });
    const afterRes = await settingsRef.get().catch(() => null);
    const after = inspect(pair.me, pair.partner, afterRes && afterRes.data, pair);
    return { success: true, mode, pairKey: pair.pairKey, migrated, summary: after, errors: [] };
  } catch (err) {
    if (err && err.name === 'BusinessError') return { success: false, mode, code: err.code, msg: err.message };
    console.error('[migrateBanners] failed:', err && (err.errMsg || err.message || err));
    return { success: false, mode, code: 'MIGRATION_FAILED', msg: 'Banner 迁移执行失败，请查看云函数日志' };
  }
};
