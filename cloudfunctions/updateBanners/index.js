// 云函数：updateBanners —— 管理首页轮播图
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const MAX_BANNERS = 10;

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const { action, fileID, fileIDs, order } = event;
  // action: 'add' | 'remove' | 'reorder'
  // add:     fileIDs = [fileID1, fileID2, ...]  （批量添加）
  // remove:  fileID = 'xxx'                      （单张删除）
  // reorder: order = [fileID1, fileID3, fileID2] （整体替换为新顺序）
  const users = db.collection('users');

  console.log('[updateBanners] action:', action, 'OPENID:', (OPENID || '').slice(-6) + '...');

  try {
    const meRes = await users.where({ openid: OPENID }).get();
    if (meRes.data.length === 0) return { success: false, msg: '请先登录' };
    const me = meRes.data[0];
    console.log('[updateBanners] 当前用户 _id:', me._id, ', partnerId:', me.partnerId || '无');

    let banners = Array.isArray(me.banners) ? me.banners : [];

    if (action === 'add') {
      const newIDs = Array.isArray(fileIDs) ? fileIDs : (fileID ? [fileID] : []);
      if (newIDs.length === 0) return { success: false, msg: '缺少图片' };
      if (banners.length + newIDs.length > MAX_BANNERS) {
        return { success: false, msg: `最多 ${MAX_BANNERS} 张轮播图` };
      }
      banners = banners.concat(newIDs);
    } else if (action === 'remove') {
      if (!fileID) return { success: false, msg: '缺少图片' };
      banners = banners.filter((f) => f !== fileID);
    } else if (action === 'reorder') {
      if (!Array.isArray(order)) return { success: false, msg: '参数错误' };
      banners = order;
    } else {
      return { success: false, msg: '未知操作' };
    }

    await users.doc(me._id).update({ data: { banners } });
    console.log('[updateBanners] 当前用户写入成功, banners:', banners.length, '张');

    // ========== 同步到伴侣 ==========
    // 轮播图为情侣共享资源，一方上传/删除/排序后，伴侣侧也要同步更新
    let synced = false;
    if (me.partnerId) {
      try {
        await users.doc(me.partnerId).update({ data: { banners } });
        // 读回验证：确认伴侣文档确实写入成功
        const verifyRes = await users.doc(me.partnerId).field({ banners: true }).get();
        const partnerBanners = Array.isArray(verifyRes.data.banners) ? verifyRes.data.banners : [];
        synced = partnerBanners.length === banners.length;
        console.log('[updateBanners] 同步到伴侣 partnerId:', me.partnerId,
          ', banners:', banners.length, '张',
          ', 验证:', synced ? '✅ 成功' : '❌ 不一致(伴侣实际:' + partnerBanners.length + '张)');
      } catch (syncErr) {
        console.error('[updateBanners] ❌ 同步到伴侣失败:', syncErr.errMsg || syncErr.message || syncErr,
          ', partnerId:', me.partnerId);
      }
    } else {
      console.log('[updateBanners] 用户未绑定伴侣，跳过同步');
    }

    return { success: true, banners, synced: synced, partnerId: me.partnerId || '' };
  } catch (err) {
    console.error('[updateBanners] 失败', err);
    return { success: false, msg: '操作失败，请重试' };
  }
};