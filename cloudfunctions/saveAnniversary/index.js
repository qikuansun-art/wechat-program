const crypto = require('crypto');
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

class BusinessError extends Error {
  constructor(message, code) { super(message); this.name = 'BusinessError'; this.code = code; }
}
function validDate(value) {
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) return false;
  const parts = value.split('-').map(Number);
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return date.getUTCFullYear() === parts[0] && date.getUTCMonth() === parts[1] - 1 && date.getUTCDate() === parts[2];
}
function shanghaiToday() {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}
function pairInfo(me, partner) {
  const memberIds = [me._id, partner._id].sort();
  const pairKey = memberIds.join('|');
  return { memberIds, pairKey, documentId: crypto.createHash('sha256').update(pairKey).digest('hex') };
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const anniversaryDate = String(event.anniversaryDate || '');
  if (!validDate(anniversaryDate)) return { success: false, code: 'INVALID_DATE', msg: '纪念日期不正确' };
  if (anniversaryDate > shanghaiToday()) return { success: false, code: 'FUTURE_DATE', msg: '纪念日不能晚于今天' };
  try {
    const users = db.collection('users');
    const initialRes = await users.where({ openid: OPENID }).get();
    if (initialRes.data.length !== 1) return { success: false, code: 'USER_NOT_FOUND', msg: '请先登录' };
    const initialMe = initialRes.data[0];
    if (!initialMe.partnerId) return { success: false, code: 'NOT_BOUND', msg: '请先绑定伴侣' };
    const initialPartnerRes = await users.doc(initialMe.partnerId).get().catch(() => null);
    const initialPartner = initialPartnerRes && initialPartnerRes.data;
    if (!initialPartner || initialPartner.partnerId !== initialMe._id) {
      return { success: false, code: 'BINDING_INVALID', msg: '绑定关系异常，请重新绑定' };
    }
    let committed = null;
    await db.runTransaction(async (transaction) => {
      const meRes = await transaction.collection('users').doc(initialMe._id).get();
      const me = meRes && meRes.data;
      if (!me || me.openid !== OPENID || !me.partnerId) throw new BusinessError('绑定关系已变化，请刷新后重试', 'BINDING_INVALID');
      const partnerRes = await transaction.collection('users').doc(me.partnerId).get().catch(() => null);
      const partner = partnerRes && partnerRes.data;
      if (!partner || partner.partnerId !== me._id) throw new BusinessError('绑定关系异常，请重新绑定', 'BINDING_INVALID');
      const pair = pairInfo(me, partner);
      const ref = transaction.collection('couple_settings').doc(pair.documentId);
      const existingRes = await ref.get().catch(() => null);
      const existing = existingRes && existingRes.data;
      const now = db.serverDate();
      const record = {
        pairKey: pair.pairKey,
        memberIds: pair.memberIds,
        anniversaryDate,
        createdAt: existing && existing.createdAt ? existing.createdAt : now,
        updatedAt: now,
        updatedBy: me._id
      };
      if (existing) await ref.update({ data: record });
      else await ref.set({ data: record });
      committed = Object.assign({ _id: pair.documentId }, record);
    });
    return { success: true, settings: { anniversaryDate: committed.anniversaryDate, updatedAt: committed.updatedAt } };
  } catch (err) {
    if (err && err.name === 'BusinessError') return { success: false, code: err.code, msg: err.message };
    console.error('[saveAnniversary] 失败', err);
    return { success: false, code: 'SAVE_FAILED', msg: '纪念日保存状态未确认，请重试' };
  }
};
