# 生成 tabBar 图标：4 个 Tab × 灰色/粉色两套，81x81 PNG
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'images')
os.makedirs(OUT, exist_ok=True)

SIZE = 81
GREY = (154, 160, 166, 255)   # #9AA0A6
PINK = (255, 107, 129, 255)   # #FF6B81


def new_canvas():
    img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def draw_home(d, color):
    """房子：圆角屋顶 + 方形屋身"""
    # 屋身
    d.rounded_rectangle([20, 34, 61, 66], radius=4, outline=color, width=4)
    # 屋顶
    d.line([(14, 36), (40.5, 16), (67, 36)], fill=color, width=4, joint='curve')
    # 门
    d.rounded_rectangle([35, 48, 47, 66], radius=3, fill=color)
    # 烟囱
    d.rounded_rectangle([52, 22, 60, 32], radius=3, fill=color)


def draw_message(d, color):
    """消息气泡：圆角方形 + 尾巴"""
    d.rounded_rectangle([16, 22, 65, 56], radius=10, outline=color, width=4)
    d.polygon([(28, 54), (36, 64), (40, 54)], fill=color)
    # 内容点
    d.ellipse([28, 33, 34, 39], fill=color)
    d.ellipse([39, 33, 45, 39], fill=color)
    d.ellipse([50, 33, 56, 39], fill=color)


def draw_record(d, color):
    """列表：三条横线 + 圆点"""
    for y in (26, 40, 54):
        d.ellipse([22, y, 32, y + 10], fill=color)
        d.line([(40, y + 5), (60, y + 5)], fill=color, width=4)


def draw_mine(d, color):
    """人形：圆头 + 肩膀"""
    d.ellipse([30, 16, 51, 37], outline=color, width=4)
    d.arc([17, 38, 64, 74], start=0, end=180, fill=color, width=4)


DRAWERS = {
    'home': draw_home,
    'message': draw_message,
    'record': draw_record,
    'mine': draw_mine,
}
COLORS = {'gray': GREY, 'pink': PINK}

for name, fn in DRAWERS.items():
    for cname, color in COLORS.items():
        img, d = new_canvas()
        fn(d, color)
        path = os.path.join(OUT, f'tab-{name}-{cname}.png')
        img.save(path, 'PNG')
        print('generated:', path)
