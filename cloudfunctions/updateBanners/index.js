// 云函数：updateBanners —— 原子管理双方共享的首页 Banner
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const MAX_BANNERS = 10;
const CLOUD_FILE_ID_PATTERN = /^cloud:\/\/[^/\s]+\/.+/;

class BusinessError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BusinessError';
    this.code = code || 'BANNER_UPDATE_REJECTED';
  }
}

function normalizedBanners(value) {
  return Array.isArray(value) ? value.slice() : [];
}

function sameOrderedList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameFileSet(left, right) {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== left.length || rightSet.size !== right.length) return false;
  return leftSet.size === rightSet.size && Array.from(leftSet).every((value) => rightSet.has(value));
}

function isCloudFileID(value) {
  return typeof value === 'string' && CLOUD_FILE_ID_PATTERN.test(value);
}

function applyAction(current, event) {
  const action = event.action;
  if (action === 'add') {
    const input = Array.isArray(event.fileIDs) ? event.fileIDs : (event.fileID ? [event.fileID] : []);
    if (input.length === 0) throw new BusinessError('缺少图片', 'MISSING_FILE');
    if (!input.every(isCloudFileID)) throw new BusinessError('图片文件标识不合法', 'INVALID_FILE_ID');
    const additions = Array.from(new Set(input));
    const existing = new Set(current);
    const banners = current.concat(additions.filter((fileID) => !existing.has(fileID)));
    if (banners.length > MAX_BANNERS) throw new BusinessError(`最多 ${MAX_BANNERS} 张轮播图`, 'BANNER_LIMIT_EXCEEDED');
    return banners;
  }
  if (action === 'remove' || action === 'delete') {
    const fileID = event.fileID;
    if (!isCloudFileID(fileID)) throw new BusinessError('图片文件标识不合法', 'INVALID_FILE_ID');
    if (!current.includes(fileID)) throw new BusinessError('该图片已不存在，请刷新后重试', 'BANNER_NOT_FOUND');
    return current.filter((value) => value !== fileID);
  }
  if (action === 'reorder') {
    if (!Array.isArray(event.order) || !event.order.every(isCloudFileID)) {
      throw new BusinessError('排序参数不合法', 'INVALID_REORDER');
    }
    if (!sameFileSet(current, event.order)) {
      throw new BusinessError('排序只能调整现有图片的顺序，请刷新后重试', 'INVALID_REORDER');
    }
    return event.order.slice();
  }
  throw new BusinessError('未知操作', 'UNKNOWN_ACTION');
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const users = db.collection('users');
  try {
    const meRes = await users.where({ openid: OPENID }).get();
    if (meRes.data.length !== 1) return { success: false, msg: '请先登录', code: 'USER_NOT_FOUND' };
    const meId = meRes.data[0]._id;

    const txRes = await db.runTransaction(async (transaction) => {
      const meRef = transaction.collection('users').doc(meId);
      const freshMeRes = await meRef.get();
      const me = freshMeRes && freshMeRes.data;
      if (!me || me.openid !== OPENID) throw new BusinessError('当前用户状态异常，请重新登录', 'USER_STATE_CHANGED');

      const meBanners = normalizedBanners(me.banners);
      let partnerRef = null;
      if (me.partnerId) {
        partnerRef = transaction.collection('users').doc(me.partnerId);
        let partnerRes;
        try {
          partnerRes = await partnerRef.get();
        } catch (err) {
          throw new BusinessError('伴侣资料异常，请检查绑定关系', 'PARTNER_NOT_FOUND');
        }
        const partner = partnerRes && partnerRes.data;
        if (!partner || me.partnerId !== partner._id || partner.partnerId !== me._id) {
          throw new BusinessError('双方绑定关系不一致，请先修复绑定关系', 'PARTNER_MISMATCH');
        }
        const partnerBanners = normalizedBanners(partner.banners);
        if (!sameOrderedList(meBanners, partnerBanners)) {
          throw new BusinessError('双方历史 Banner 数据不一致，请人工确认后修复', 'BANNER_HISTORY_CONFLICT');
        }
      }

      const banners = applyAction(meBanners, event);
      await meRef.update({ data: { banners } });
      if (partnerRef) await partnerRef.update({ data: { banners } });
      return { banners, partnerId: me.partnerId || '' };
    });

    return { success: true, banners: txRes.result.banners, synced: !!txRes.result.partnerId, partnerId: txRes.result.partnerId };
  } catch (err) {
    if (err && err.name === 'BusinessError') return { success: false, msg: err.message, code: err.code };
    console.error('[updateBanners] transaction failed:', err && (err.errMsg || err.message || err));
    return { success: false, msg: '操作失败，请重试', code: 'TRANSACTION_FAILED' };
  }
};
