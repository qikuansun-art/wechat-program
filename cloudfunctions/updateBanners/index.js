const crypto = require('crypto');
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const MAX_BANNERS = 10;
const CLOUD_FILE_ID_PATTERN = /^cloud:\/\/([^/\s]+)\/(.+)$/;
class BusinessError extends Error {
  constructor(message, code) { super(message); this.name = 'BusinessError'; this.code = code || 'BANNER_UPDATE_REJECTED'; }
}
function pairInfo(me, partner) {
  const memberIds = [me._id, partner._id].sort();
  const pairKey = memberIds.join('|');
  return { memberIds, pairKey, documentId: crypto.createHash('sha256').update(pairKey).digest('hex') };
}
function parseCloudFileID(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(CLOUD_FILE_ID_PATTERN);
  return match ? { env: match[1], path: match[2] } : null;
}
function validateNewBannerFileID(fileID, openid, env) {
  const parsed = parseCloudFileID(fileID);
  if (!parsed) throw new BusinessError('图片文件标识不合法', 'INVALID_FILE_ID');
  if (!env) throw new BusinessError('无法确认当前云环境', 'ENV_UNAVAILABLE');
  if (parsed.env !== env) throw new BusinessError('图片不属于当前云环境', 'FILE_ENV_MISMATCH');
  if (!parsed.path.startsWith(`banners/${openid}/`)) throw new BusinessError('只能添加当前用户上传的 Banner', 'FILE_OWNER_MISMATCH');
}
function sameFileSet(left, right) {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left), rightSet = new Set(right);
  if (leftSet.size !== left.length || rightSet.size !== right.length) return false;
  return leftSet.size === rightSet.size && Array.from(leftSet).every((value) => rightSet.has(value));
}
function applyAction(current, event, openid, env) {
  const action = event.action;
  if (action === 'add') {
    const input = Array.isArray(event.fileIDs) ? event.fileIDs : (event.fileID ? [event.fileID] : []);
    if (input.length === 0) throw new BusinessError('缺少图片', 'MISSING_FILE');
    input.forEach((fileID) => validateNewBannerFileID(fileID, openid, env));
    const existing = new Set(current);
    const banners = current.concat(Array.from(new Set(input)).filter((fileID) => !existing.has(fileID)));
    if (banners.length > MAX_BANNERS) throw new BusinessError(`最多 ${MAX_BANNERS} 张轮播图`, 'BANNER_LIMIT_EXCEEDED');
    return banners;
  }
  if (action === 'remove' || action === 'delete') {
    if (!parseCloudFileID(event.fileID)) throw new BusinessError('图片文件标识不合法', 'INVALID_FILE_ID');
    if (!current.includes(event.fileID)) throw new BusinessError('该图片已不存在，请刷新后重试', 'BANNER_NOT_FOUND');
    return current.filter((value) => value !== event.fileID);
  }
  if (action === 'reorder') {
    if (!Array.isArray(event.order) || !event.order.every((fileID) => !!parseCloudFileID(fileID))) throw new BusinessError('排序参数不合法', 'INVALID_REORDER');
    if (!sameFileSet(current, event.order)) throw new BusinessError('排序只能调整现有图片的顺序，请刷新后重试', 'INVALID_REORDER');
    return event.order.slice();
  }
  throw new BusinessError('未知操作', 'UNKNOWN_ACTION');
}

exports.main = async (event = {}) => {
  const context = cloud.getWXContext();
  const OPENID = context.OPENID;
  const ENV = context.ENV;
  const action = event.action || 'unknown';
  try {
    const users = db.collection('users');
    const meRes = await users.where({ openid: OPENID }).get();
    if (meRes.data.length !== 1) return { success: false, code: 'USER_NOT_FOUND', msg: '请先登录' };
    const initialMe = meRes.data[0];
    if (!initialMe.partnerId) return { success: false, code: 'NOT_BOUND', msg: '请先绑定伴侣' };
    let committedBanners = [];
    console.log('[updateBanners][TRANSACTION_START]', { action });
    await db.runTransaction(async (transaction) => {
      const freshMeRes = await transaction.collection('users').doc(initialMe._id).get();
      const me = freshMeRes && freshMeRes.data;
      if (!me || me.openid !== OPENID || !me.partnerId) throw new BusinessError('绑定关系已变化，请刷新后重试', 'BINDING_INVALID');
      const partnerRes = await transaction.collection('users').doc(me.partnerId).get().catch(() => null);
      const partner = partnerRes && partnerRes.data;
      if (!partner || partner.partnerId !== me._id) throw new BusinessError('绑定关系异常，请重新绑定', 'BINDING_INVALID');
      const pair = pairInfo(me, partner);
      const ref = transaction.collection('couple_settings').doc(pair.documentId);
      const existingRes = await ref.get().catch(() => null);
      const existing = existingRes && existingRes.data;
      if (existing && existing.pairKey !== pair.pairKey) throw new BusinessError('情侣设置数据异常', 'SETTINGS_CONFLICT');
      const banners = applyAction(existing && Array.isArray(existing.banners) ? existing.banners.slice() : [], event, OPENID, ENV);
      const now = db.serverDate();
      if (existing) await ref.update({ data: { banners, updatedAt: now, updatedBy: me._id } });
      else await ref.set({ data: { pairKey: pair.pairKey, memberIds: pair.memberIds, banners, createdAt: now, updatedAt: now, updatedBy: me._id } });
      committedBanners = banners.slice();
    });
    console.log('[updateBanners][TRANSACTION_SUCCESS]', { action, bannerCount: committedBanners.length });
    console.log('[updateBanners][FUNCTION_RETURN_SUCCESS]', { action, bannerCount: committedBanners.length });
    return { success: true, banners: committedBanners, synced: true };
  } catch (err) {
    console.error('[updateBanners][FUNCTION_ERROR]', { action, code: err && (err.code || err.errCode) || '', message: err && (err.errMsg || err.message) || String(err || '') });
    if (err && err.name === 'BusinessError') return { success: false, code: err.code, msg: err.message };
    return { success: false, code: 'TRANSACTION_FAILED', msg: '操作失败，请重试' };
  }
};
