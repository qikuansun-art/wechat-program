// pages/detail/detail.js —— 报备详情 + 审批操作
const util = require('../../utils/util');
const config = require('../../utils/config');

Page({
  data: {
    loading: true,
    report: null,
    // 我的角色：creator=我是发起人，approver=我是审批人
    myRole: '',
    canApprove: false,
    approving: false,
    // 驳回弹层
    showReject: false,
    rejectReason: ''
  },

  onLoad(options) {
    this.reportId = options.id || '';
    this.loadDetail();
  },

  async loadDetail() {
    if (!this.reportId) {
      util.toast('参数错误');
      setTimeout(() => wx.navigateBack(), 1000);
      return;
    }
    const app = getApp();
    const userInfo = await app.ensureLogin();
    if (!userInfo) return;
    try {
      const res = await wx.cloud.callFunction({
        name: 'getReportDetail',
        data: { reportId: this.reportId }
      });
      const result = res.result || {};
      if (!result.success) {
        util.toast(result.msg || '加载失败');
        setTimeout(() => wx.navigateBack(), 1000);
        return;
      }
      const report = this.formatReport(result.report);
      const myRole = result.myRole || '';

      this.setData({
        loading: false,
        report,
        myRole,
        canApprove: myRole === 'approver' && report.status === 'pending'
      });

      // 审批人查看待审批报备时，主动引导授权 new_report
      // 确保伴侣下次发起报备时自己能收到订阅消息提醒
      if (myRole === 'approver' && report.status === 'pending') {
        this.requestSubscribe();
      }
    } catch (err) {
      console.error('加载详情失败', err);
      this.setData({ loading: false });
      util.toast('加载失败，请重试');
    }
  },

  formatReport(report) {
    const formatted = Object.assign({}, report);
    formatted.createdAtText = util.prettyTime(formatted.createdAt);
    formatted.processedAtText = util.prettyTime(formatted.processedAt);
    formatted.statusText = util.statusText(formatted.status);
    formatted.statusClass = util.statusClass(formatted.status);
    return formatted;
  },

  /** 预览服务端鉴权后签发的图片临时地址 */
  onPreviewImage(e) {
    const idx = e.currentTarget.dataset.idx;
    const urls = this.data.report.imageUrls || [];
    if (!urls.length || !urls[idx]) return;
    wx.previewImage({ current: urls[idx], urls });
  },

  /** 批准 */
  onApprove() {
    const that = this;
    wx.showModal({
      title: '批准报备',
      content: `确定批准「${this.data.report.location}」吗？`,
      confirmText: '批准',
      confirmColor: '#07C160',
      success(res) {
        if (res.confirm) that.doApprove('approve');
      }
    });
  },

  /** 打开驳回弹层 */
  onReject() {
    this.setData({ showReject: true, rejectReason: '' });
  },

  /** 驳回理由输入 */
  onRejectInput(e) {
    this.setData({ rejectReason: e.detail.value });
  },

  /** 驳回理由失焦兜底（防止 bindinput 未及时同步） */
  onRejectBlur(e) {
    this.setData({ rejectReason: e.detail.value || '' });
  },

  /** 确认驳回 */
  onRejectConfirm() {
    // 二次取值：优先用 data 中的值，同时做 trim 校验
    const reason = (this.data.rejectReason || '').trim();
    if (!reason) return util.toast('请填写驳回理由');
    this.setData({ showReject: false });
    this.doApprove('reject', reason);
  },

  /** 关闭驳回弹层 */
  onRejectCancel() {
    this.setData({ showReject: false });
  },

  /** 弹层内部点击（阻止冒泡，不关闭弹层） */
  onModalTap() {
    // 空函数，仅用于 catchtap 阻止事件冒泡到外层 mask
  },

  /** 审批前请求订阅授权
   *  审批人(approver) → 授权 new_report，确保下次伴侣发起报备时能收到提醒
   *  发起人(creator)  → 授权 approve_result，确保审批结果能推送给自己
   */
  requestSubscribe() {
    // 根据角色选择正确的模板
    const isApprover = this.data.myRole === 'approver';
    const tmplId = isApprover ? config.TEMPLATE_NEW_REPORT : config.TEMPLATE_APPROVE_RESULT;
    const subType = isApprover ? 'new_report' : 'approve_result';
    if (!tmplId || tmplId.indexOf('请替换') >= 0) return;
    wx.requestSubscribeMessage({
      tmplIds: [tmplId],
      success: (res) => {
        if (res[tmplId] === 'accept') {
          wx.cloud.callFunction({ name: 'subscribe', data: { type: subType } })
            .catch((err) => console.error('记录订阅失败', err));
        }
      },
      fail: () => {}
    });
  },

  /** 执行审批 */
  async doApprove(action, reason) {
    if (this.data.approving || !this.data.canApprove) return;
    // 审批时再次请求订阅授权（根据角色授权对应模板）
    this.requestSubscribe();
    this.setData({ approving: true });
    wx.showLoading({ title: '提交中...', mask: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'approveReport',
        data: { reportId: this.reportId, action, reason: reason || '' }
      });
      const result = res.result || {};
      console.log('[Approve][CALL_RESOLVE]', { success: result.success === true, code: result.code || '' });
      if (result.success) {
        this.finishApproval(action);
      } else {
        await this.reconcileApproval(action);
      }
    } catch (err) {
      console.error('[Approve][CALL_REJECT]', { errMsg: err && err.errMsg, errCode: err && err.errCode });
      await this.reconcileApproval(action);
    } finally {
      wx.hideLoading();
    }
  },

  finishApproval(action, report) {
    const targetStatus = action === 'approve' ? 'approved' : 'rejected';
    const nextReport = this.formatReport(report || Object.assign({}, this.data.report, { status: targetStatus }));
    this.setData({ report: nextReport, canApprove: false, approving: false, showReject: false });
    console.log('[Approve][FINAL_DECISION]', { decision: 'success', status: targetStatus });
    util.toast(action === 'approve' ? '已批准' : '已驳回');
  },

  async reconcileApproval(action) {
    const targetStatus = action === 'approve' ? 'approved' : 'rejected';
    console.log('[Approve][RECONCILE_START]', { targetStatus });
    try {
      const res = await wx.cloud.callFunction({ name: 'getReportDetail', data: { reportId: this.reportId } });
      const result = res.result || {};
      const report = result.success && result.report ? result.report : null;
      console.log('[Approve][RECONCILE_RESULT]', { success: !!report, status: report && report.status || '' });
      if (!report) throw new Error(result.msg || '对账失败');
      if (report.status === targetStatus) {
        this.finishApproval(action, report);
        return;
      }
      const formatted = this.formatReport(report);
      if (report.status === 'pending') {
        this.setData({ report: formatted, canApprove: false, approving: false, showReject: false });
        console.log('[Approve][FINAL_DECISION]', { decision: 'unknown', status: report.status });
        util.toast('审批状态未确认，请稍后刷新');
        return;
      }
      this.setData({ report: formatted, canApprove: false, approving: false, showReject: false });
      console.log('[Approve][FINAL_DECISION]', { decision: 'conflict', status: report.status });
      util.toast('该报备已被处理，请查看最新结果');
    } catch (err) {
      console.error('[Approve][RECONCILE_RESULT]', { success: false, errMsg: err && (err.errMsg || err.message) });
      this.setData({ approving: false, canApprove: false, showReject: false });
      console.log('[Approve][FINAL_DECISION]', { decision: 'unknown' });
      util.toast('审批状态未确认，请稍后刷新');
    }
  }
});
