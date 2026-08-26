const crypto = require('crypto');
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

function pairInfo(me, partner) {
  const memberIds = [me._id, partner._id].sort();
  const pairKey = memberIds.join('|');
  return { pairKey, documentId: crypto.createHash('sha256').update(pairKey).digest('hex') };
}

async function getCurrentPair(openid) {
  const users = db.collection('users');
  const meRes = await users.where({ openid }).get();
  if (meRes.data.length !== 1) return { error: { success: false, code: 'USER_NOT_FOUND', msg: '请先登录', items: [] } };
  const me = meRes.data[0];
  if (!me.partnerId) return { error: { success: false, code: 'NOT_BOUND', msg: '请先绑定伴侣', items: [] } };
  const partnerRes = await users.doc(me.partnerId).get().catch(() => null);
  const partner = partnerRes && partnerRes.data;
  if (!partner || partner.partnerId !== me._id) return { error: { success: false, code: 'BINDING_INVALID', msg: '绑定关系异常，请重新绑定', items: [] } };
  return Object.assign({ me, partner }, pairInfo(me, partner));
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  try {
    const pair = await getCurrentPair(OPENID);
    if (pair.error) return pair.error;
    const settingsRes = await db.collection('couple_settings').doc(pair.documentId).get().catch(() => null);
    const settings = settingsRes && settingsRes.data;
    if (settings && settings.pairKey !== pair.pairKey) return { success: false, code: 'SETTINGS_CONFLICT', msg: '情侣设置数据异常', items: [] };
    const banners = settings && Array.isArray(settings.banners) ? settings.banners.slice() : [];
    if (banners.length === 0) return { success: true, banners: [], items: [] };
    let tempResult;
    try {
      tempResult = await cloud.getTempFileURL({ fileList: banners });
    } catch (err) {
      console.error('[getSharedBanners] temporary URL request failed:', err && (err.errMsg || err.message || err));
      return { success: true, banners, items: banners.map((fileID) => ({ fileID, tempURL: '', success: false, errMsg: '临时链接获取失败' })) };
    }
    const files = Array.isArray(tempResult.fileList) ? tempResult.fileList : [];
    const byFileID = new Map(files.map((file) => [file.fileID, file]));
    const items = banners.map((fileID, index) => {
      const file = byFileID.get(fileID) || files[index] || {};
      const ok = file.status === 0 && !!file.tempFileURL;
      return { fileID, tempURL: ok ? file.tempFileURL : '', success: ok, errMsg: ok ? '' : (file.errMsg || '临时链接获取失败') };
    });
    return { success: true, banners, items };
  } catch (err) {
    console.error('[getSharedBanners] failed:', err && (err.errMsg || err.message || err));
    return { success: false, code: 'QUERY_FAILED', msg: 'Banner 加载失败，请稍后重试', items: [] };
  }
};
