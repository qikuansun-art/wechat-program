// 云函数：sendNotify —— 已停用的旧通用发送入口
// 通知现由 createReport / approveReport 根据真实业务数据直接发送。
// 保留此函数是为了覆盖旧云端部署，防止客户端继续调用历史通用接口。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event, context) => {
  console.warn('[sendNotify] 已拒绝调用：旧通用通知接口已停用');
  return { success: false, msg: '接口已停用' };
};
