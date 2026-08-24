// utils/config.js —— 订阅消息模板配置
//
// ⚠️ 使用前必读：
// 1. 登录微信公众平台 https://mp.weixin.qq.com
// 2. 左侧菜单「功能」→「订阅消息」→「公共模板库」→ 搜索并选用合适的模板（添加后即为可用模板）
//    - 「报备通知」模板：关键词含 报备内容 / 报备时间 / 发起人 等（给审批方用）
//    - 「审批结果通知」模板：关键词含 审批结果 / 报备内容 / 处理时间 等（给发起方用）
// 3. 添加后在我的模板列表里复制模板 ID，替换下方两个常量
// 4. 同时也要把模板 ID 填到 cloudfunctions/sendNotify/index.js 里的 TEMPLATES

module.exports = {
  // 模板 ID 占位符：请替换为你在公众平台申请到的真实模板 ID
  TEMPLATE_NEW_REPORT: '9Olki2zL-v7V_Nse9V0MNTWq2d8nlTIo6aW1YV1Gmvg',
  TEMPLATE_APPROVE_RESULT: 'nrteb3ujtZBTIHtyABGP0FGP3Dy19PxRelc0IFFnaB8'
};
