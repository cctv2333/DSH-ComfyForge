#!/usr/bin/env python
# imgtools.py — 角色图的"拆"与"拼"
#
#   split   把一张多视图设定图按白底空隙切成单个视图（评分前必须先切，否则 CLIP 会平均掉）
#   compose 把若干单视图拼成一张设定图：等高归一化 + 底边对齐 + 等间距 + 可选标题
#
# 为什么需要：整张多视图丢给 CLIP，会得到"这不是同一个人"的假阴性（实测 sheet_v3 只有 0.742，
# 而同样的单人图是 0.82+）。评分的单位必须是"一个人物"，不是"一张画布"。
import sys, os
from PIL import Image, ImageChops
import numpy as np

WHITE_TH = 12          # 与纯白的差超过这个值算"有内容"
MIN_BAND_W = 24        # 太窄的竖向带子不算一个视图（排除细线/装饰）


def bg_color(im):
    """从图像四边采样估计背景色（白、灰、米色都能处理）"""
    a = np.asarray(im.convert('RGB')).astype(np.int16)
    edge = np.concatenate([a[0, :], a[-1, :], a[:, 0], a[:, -1]], axis=0)
    return np.median(edge, axis=0)


def content_mask(im):
    a = np.asarray(im.convert('RGB')).astype(np.int16)
    bg = bg_color(im)
    d = np.abs(a - bg).max(axis=2)     # 离背景色有多远
    return d > WHITE_TH


def split(path, outdir):
    im = Image.open(path).convert('RGB')
    m = content_mask(im)
    col = m.sum(axis=0)                 # 每列有多少内容像素
    active = col > 0
    bands = []
    i = 0
    while i < len(active):
        if not active[i]:
            i += 1
            continue
        j = i
        while j < len(active) and active[j]:
            j += 1
        if j - i >= MIN_BAND_W:
            bands.append((i, j))
        i = j
    os.makedirs(outdir, exist_ok=True)
    made = []
    for k, (x0, x1) in enumerate(bands):
        sub = m[:, x0:x1]
        rows = np.where(sub.sum(axis=1) > 0)[0]
        if not len(rows):
            continue
        y0, y1 = int(rows[0]), int(rows[-1]) + 1
        pad = 8
        box = (max(0, x0 - pad), max(0, y0 - pad), min(im.width, x1 + pad), min(im.height, y1 + pad))
        crop = im.crop(box)
        out = os.path.join(outdir, f'view_{k}.png')
        crop.save(out)
        made.append((out, crop.size))
        print(f'{out}  {crop.size[0]}x{crop.size[1]}  从 x={box[0]}..{box[2]}')
    if not made:
        print('没切出内容：可能整张图没有白底空隙')
    return made


def trim(im, th=WHITE_TH):
    m = content_mask(im)
    rows = np.where(m.sum(axis=1) > 0)[0]
    cols = np.where(m.sum(axis=0) > 0)[0]
    if not len(rows) or not len(cols):
        return im
    return im.crop((int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1))


def compose(out, paths, height=900, gap=40, bg=(255, 255, 255), label=True):
    """等高归一化（按人物高度），底边对齐，等间距排开。"""
    figs = []
    for p in paths:
        im = trim(Image.open(p).convert('RGB'))
        scale = height / im.height
        im = im.resize((max(1, int(im.width * scale)), height), Image.LANCZOS)
        figs.append((p, im))
    total_w = sum(im.width for _, im in figs) + gap * (len(figs) + 1)
    canvas = Image.new('RGB', (total_w, height + gap * 2), bg)
    x = gap
    for p, im in figs:
        canvas.paste(im, (x, gap + (height - im.height)))   # 底边对齐
        x += im.width + gap
    canvas.save(out)
    print(f'{out}  {canvas.width}x{canvas.height}  {len(figs)} 个视图  (每个高 {height}px)')
    return out




def figure_mask(im):
    """背景可能是有渐变的，单一阈值不可靠：依次收紧阈值，取第一个能把人物框住的。
    仍框不住（>85% 画布）就返回 None，让调用方标 unknown 而不是猜。"""
    for th in (12, 30, 60):
        a = np.asarray(im.convert('RGB')).astype(np.int16)
        bg = bg_color(im)
        mask = np.abs(a - bg).max(axis=2) > th
        rows = np.where(mask.sum(axis=1) > 0)[0]; cols = np.where(mask.sum(axis=0) > 0)[0]
        if not len(rows) or not len(cols):
            continue
        # 判据：背景应该"不占据边框"。若边框上几乎全是内容，说明这是渐变背景，
        # 此时包围盒 = 整幅画布，任何几何特征都不可信 -> 换更严的阈值，再不行返回 None
        border = np.concatenate([mask[0, :], mask[-1, :], mask[:, 0], mask[:, -1]])
        if border.mean() < 0.35:
            return mask, rows, cols
    return None, None, None


def view_features(path):
    """判断正/侧/背用的三个可计算量：轮廓宽高比、左右对称度、上半身肤色占比。"""
    im = Image.open(path).convert('RGB')
    m, rows, cols = figure_mask(im)
    if m is None:
        return None
    sub = m[rows[0]:rows[-1]+1, cols[0]:cols[-1]+1]
    h, w = sub.shape
    # 对称度：左右镜像后的 IoU
    mir = sub[:, ::-1]
    inter = np.logical_and(sub, mir).sum()
    union = np.logical_or(sub, mir).sum() or 1
    sym = float(inter) / float(union)
    # 上半身（脸部区域）肤色占比
    a = np.asarray(im.convert('RGB')).astype(np.float32)[rows[0]:rows[0]+int(h*0.45), cols[0]:cols[-1]+1] / 255.0
    mx = a.max(axis=2); mn = a.min(axis=2)
    v = mx; sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    r, g, b = a[:,:,0], a[:,:,1], a[:,:,2]
    skin = (r > g) & (g > b) & (sat > 0.08) & (sat < 0.55) & (v > 0.55) & (v < 0.98) & (r - b > 0.04)
    skin_frac = float(skin.mean())
    # 脸部区域（上 45%、中间 70%）的边缘能量：正面有眼鼻嘴 -> 高；背面是平头发 -> 低
    face = a[int(h*0.08):int(h*0.45), int(w*0.15):int(w*0.85)]
    fm = sub[int(h*0.08):int(h*0.45), int(w*0.15):int(w*0.85)]
    if face.size and fm.any():
        gy, gx = np.gradient(face.mean(axis=2))
        mag = np.sqrt(gy**2 + gx**2)
        edge = float(mag[fm].mean())          # 只统计人物内部的边缘
    else:
        edge = 0.0
    return {'w': w, 'h': h, 'aspect': round(w / h, 3), 'sym': round(sym, 3),
            'skin': round(skin_frac, 4), 'faceEdge': round(edge, 4)}


def classify(path):
    f = view_features(path)
    if not f:
        return 'unknown', f
    # 背面：几乎没有脸/手的肤色，且轮廓较对称
    # 侧面：左右严重不对称（发际线/鼻尖只在一侧）
    if f['sym'] < 0.60:
        return 'side', f
    # 背面：对称但脸部没有五官细节（边缘能量低）
    if f['faceEdge'] < 0.040:
        return 'back', f
    return 'front', f


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'split':
        split(sys.argv[2], sys.argv[3])
    elif cmd == 'classify':
        for p in sys.argv[2:]:
            v, f = classify(p)
            print(f'{p}\t{v}\t{f}')
    elif cmd == 'compose':
        out = sys.argv[2]
        rest = sys.argv[3:]
        h = 900
        if '--height' in rest:
            i = rest.index('--height')
            h = int(rest[i + 1]); rest = rest[:i] + rest[i + 2:]
        compose(out, rest, height=h)
    else:
        print(__doc__)
        sys.exit(2)
