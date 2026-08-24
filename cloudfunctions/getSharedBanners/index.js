// 云函数：getSharedBanners —— 返回当前用户共享 Banner 的受控临时访问地址
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

function sameOrderedList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  try {
    const meRes = await db.collection('users').where({ openid: OPENID }).get();
    if (meRes.data.length !== 1) return { success: false, msg: '请先登录', items: [] };
    const me = meRes.data[0];
    const banners = Array.isArray(me.banners) ? me.banners : [];

    if (me.partnerId) {
      let partner;
      try {
        partner = (await db.collection('users').doc(me.partnerId).get()).data;
      } catch (err) {
        return { success: false, msg: '伴侣资料异常，请检查绑定关系', code: 'PARTNER_NOT_FOUND', items: [] };
      }
      if (!partner || partner.partnerId !== me._id) {
        return { success: false, msg: '双方绑定关系不一致', code: 'PARTNER_MISMATCH', items: [] };
      }
      const partnerBanners = Array.isArray(partner.banners) ? partner.banners : [];
      if (!sameOrderedList(banners, partnerBanners)) {
        return { success: false, msg: '双方历史 Banner 数据不一致，请人工确认后修复', code: 'BANNER_HISTORY_CONFLICT', items: [] };
      }
    }

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
    return { success: false, msg: 'Banner 加载失败，请稍后重试', items: [] };
  }
};
