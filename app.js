// app.js —— 全局入口
// 负责：云开发初始化、全局登录、全局数据

App({
  globalData: {
    openid: '',        // 当前用户 openid
    userInfo: null,    // 当前用户信息（来自 users 集合）
    envId: ''          // 云开发环境 ID（留空则使用默认环境）
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
    } else {
      wx.cloud.init({
        // 如果你有多个云环境，可在此填写环境 ID，例如 env: 'couple-report-xxxxx'
        // 留空则使用账号下的默认环境
        env: 'cloudbase-d8gcbf9pd0317b337',
        traceUser: true
      });
    }

    // 启动时静默登录
    this.login();
  },

  /**
   * 全局登录：调用 login 云函数，拿到 openid 和用户信息
   * 加了缓存，页面可以放心多次调用
   */
  login() {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = wx.cloud.callFunction({ name: 'login' })
      .then((res) => {
        const data = res.result || {};
        this.globalData.openid = data.openid || '';
        this.globalData.userInfo = data.userInfo || null;
        return data;
      })
      .catch((err) => {
        console.error('[login] 登录失败', err);
        this.loginPromise = null;
        return null;
      });
    return this.loginPromise;
  },

  /**
   * 页面统一入口：确保登录完成后再执行回调
   * 用法：getApp().ensureLogin().then(userInfo => { ... })
   */
  ensureLogin() {
    if (this.globalData.userInfo) {
      return Promise.resolve(this.globalData.userInfo);
    }
    return this.login().then((data) => data && data.userInfo);
  },

  /**
   * 强制从数据库刷新用户信息（清除缓存）
   * 场景：伴侣上传了轮播图/修改了昵称后，需要拉取最新数据
   */
  refreshUserInfo() {
    this.loginPromise = null;
    return wx.cloud.callFunction({ name: 'login' })
      .then((res) => {
        const data = res.result || {};
        this.globalData.openid = data.openid || this.globalData.openid;
        this.globalData.userInfo = data.userInfo || this.globalData.userInfo;
        return this.globalData.userInfo;
      })
      .catch((err) => {
        console.error('[refreshUserInfo] 刷新失败', err);
        return this.globalData.userInfo;
      });
  }
});
