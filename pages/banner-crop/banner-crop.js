const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 492;
const AREA_WIDTH_RPX = 702;
const AREA_HEIGHT_RPX = 320;

Page({
  data: {
    sourcePath: '',
    displayWidth: 0,
    displayHeight: 0,
    imageX: 0,
    imageY: 0,
    imageScale: 1,
    ready: false,
    exporting: false
  },

  onLoad() {
    this._eventChannel = this.getOpenerEventChannel();
    this._eventChannel.on('cropSource', ({ tempFilePath }) => {
      if (tempFilePath) this.prepareImage(tempFilePath);
    });
  },

  prepareImage(sourcePath) {
    wx.getImageInfo({
      src: sourcePath,
      success: (info) => {
        const windowWidth = wx.getSystemInfoSync().windowWidth;
        const areaWidth = windowWidth * AREA_WIDTH_RPX / 750;
        const areaHeight = areaWidth * AREA_HEIGHT_RPX / AREA_WIDTH_RPX;
        const coverScale = Math.max(areaWidth / info.width, areaHeight / info.height);
        const displayWidth = info.width * coverScale;
        const displayHeight = info.height * coverScale;
        const imageX = (areaWidth - displayWidth) / 2;
        const imageY = (areaHeight - displayHeight) / 2;
        this._imageInfo = info;
        this._areaWidth = areaWidth;
        this._areaHeight = areaHeight;
        this._position = { x: imageX, y: imageY, scale: 1 };
        this.setData({ sourcePath: info.path || sourcePath, displayWidth, displayHeight, imageX, imageY, imageScale: 1, ready: true });
      },
      fail: (err) => {
        console.error('[banner-crop] getImageInfo failed:', err);
        wx.showToast({ title: '图片读取失败', icon: 'none' });
      }
    });
  },

  onImageMove(e) {
    this._position = Object.assign({}, this._position, { x: e.detail.x, y: e.detail.y });
  },

  onImageScale(e) {
    this._position = { x: e.detail.x, y: e.detail.y, scale: e.detail.scale || 1 };
  },

  onCancel() {
    this._finished = true;
    if (this._eventChannel) this._eventChannel.emit('bannerCropCancelled');
    wx.navigateBack();
  },

  onUnload() {
    if (!this._finished && this._eventChannel) this._eventChannel.emit('bannerCropCancelled');
  },

  onConfirm() {
    if (!this.data.ready || this.data.exporting || !this._imageInfo) return;
    this.setData({ exporting: true });
    const position = this._position || { x: this.data.imageX, y: this.data.imageY, scale: 1 };
    const renderedWidth = this.data.displayWidth * position.scale;
    const renderedHeight = this.data.displayHeight * position.scale;
    const sourceX = Math.max(0, -position.x * this._imageInfo.width / renderedWidth);
    const sourceY = Math.max(0, -position.y * this._imageInfo.height / renderedHeight);
    const sourceWidth = Math.min(this._imageInfo.width - sourceX, this._areaWidth * this._imageInfo.width / renderedWidth);
    const sourceHeight = Math.min(this._imageInfo.height - sourceY, this._areaHeight * this._imageInfo.height / renderedHeight);
    const context = wx.createCanvasContext('bannerCropCanvas', this);
    context.drawImage(this.data.sourcePath, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
    context.draw(false, () => {
      wx.canvasToTempFilePath({
        canvasId: 'bannerCropCanvas',
        x: 0,
        y: 0,
        width: OUTPUT_WIDTH,
        height: OUTPUT_HEIGHT,
        destWidth: OUTPUT_WIDTH,
        destHeight: OUTPUT_HEIGHT,
        fileType: 'jpg',
        quality: 0.86,
        success: (res) => {
          this._finished = true;
          if (this._eventChannel) this._eventChannel.emit('bannerCropped', { tempFilePath: res.tempFilePath });
          wx.navigateBack();
        },
        fail: (err) => {
          console.error('[banner-crop] export failed:', err);
          this.setData({ exporting: false });
          wx.showToast({ title: '裁剪失败，请重试', icon: 'none' });
        }
      }, this);
    });
  }
});
