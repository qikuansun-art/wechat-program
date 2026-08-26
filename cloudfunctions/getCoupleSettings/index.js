const crypto = require('crypto');
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

function pairInfo(me, partner) {
  const memberIds = [me._id, partner._id].sort();
  const pairKey = memberIds.join('|');
  return { memberIds, pairKey, documentId: crypto.createHash('sha256').update(pairKey).digest('hex') };
}

async function getBoundUsers(openid) {
  const users = db.collection('users');
  const meRes = await users.where({ openid }).get();
  if (meRes.data.length !== 1) return { error: { success: false, code: 'USER_NOT_FOUND', msg: '请先登录' } };
  const me = meRes.data[0];
  if (!me.partnerId) return { error: { success: false, code: 'NOT_BOUND', msg: '请先绑定伴侣' } };
  const partnerRes = await users.doc(me.partnerId).get().catch(() => null);
  const partner = partnerRes && partnerRes.data;
  if (!partner || partner.partnerId !== me._id) return { error: { success: false, code: 'BINDING_INVALID', msg: '绑定关系异常，请重新绑定' } };
  return { me, partner };
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  try {
    const auth = await getBoundUsers(OPENID);
    if (auth.error) return auth.error;
    const pair = pairInfo(auth.me, auth.partner);
    const res = await db.collection('couple_settings').doc(pair.documentId).get().catch(() => null);
    const record = res && res.data;
    if (!record || record.pairKey !== pair.pairKey) return { success: true, settings: null };
    return {
      success: true,
      settings: {
        anniversaryDate: record.anniversaryDate,
        updatedAt: record.updatedAt || null
      }
    };
  } catch (err) {
    console.error('[getCoupleSettings] 失败', err);
    return { success: false, code: 'QUERY_FAILED', msg: '纪念日加载失败，请重试' };
  }
};
