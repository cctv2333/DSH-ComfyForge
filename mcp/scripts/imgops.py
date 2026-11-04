#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
imgops.py — 图像客观度量与拼图（Pillow + numpy，零第三方视觉依赖）

给「看不见图的 agent」用的眼睛替代品：
  metrics  计算分辨率/锐度/对比/色彩/裁切/九宫格局部锐度，并给出可读判定
  sheet    把 N 张图拼成一张带编号与指标的联络表（contact sheet），供视觉模型一次看全

用法:
  python imgops.py metrics --json out.json a.png b.png
  python imgops.py metrics --json - a.png            # 直接打印 JSON 到 stdout
  python imgops.py sheet --out sheet.jpg --cols 2 a.png b.png

设计约束:
  - 不联网、不改原图、不做审美判断（审美交给视觉模型；这里只给客观指标）
  - 所有阈值都写在 THRESHOLDS 里，可调；判定必须说明依据
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

# ---------------------------------------------------------------- thresholds
THRESHOLDS = {
    # FLUX / SD3 系原生约 1.0 MP；低于 0.5 MP 细节必然吃亏
    "mp_low": 0.25,      # < 0.25MP (512x512=0.26) 视为「小于模型原生分辨率」
    "mp_ok": 0.75,       # >= 0.75MP 才算达到原生量级
    "focus_ratio_soft": 0.010,   # lap_var / gray_var 低于此 → 整体偏软
    "lap512_soft": 12.0,         # 统一缩到 512 后测的拉普拉斯方差，跨分辨率可比
    "edge_pct_soft": 2.0,        # 边缘像素占比低于 2% → 细节少/糊
    "clip_hi_bad": 0.08,         # 单通道 >=250 的像素超过 8% → 高光溢出
    "clip_lo_bad": 0.06,         # 单通道 <=5 的像素超过 6% → 暗部死黑
    "flat_contrast": 0.05,       # 灰度标准差 < 0.05 → 画面平板
    "tile_ratio_soft": 0.05,     # 最糊格子/最锐格子 < 0.05 → 疑似局部糊（也常是浅景深，仅供参考）
}


def _load(path):
    img = Image.open(path)
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    elif img.mode == "L":
        img = img.convert("RGB")
    return img


def _lap_var(gray):
    """3x3 拉普拉斯响应方差（越大越锐）。纯 numpy，不依赖 cv2。

    注意：gray 是 0..1 归一化值，必须乘以 255 再算——否则方差被压缩 65025 倍，
    会让一张很锐的图看起来「糊」（这是第一版踩过的坑）。
    """
    g = gray.astype(np.float32) * 255.0
    if g.shape[0] < 3 or g.shape[1] < 3:
        return 0.0
    lap = (-4.0 * g[1:-1, 1:-1]
           + g[:-2, 1:-1] + g[2:, 1:-1]
           + g[1:-1, :-2] + g[1:-1, 2:])
    return float(lap.var())


def _gray512(gray):
    """把灰度图缩到最长边 512，用于跨分辨率比较「单位视场的细节量」。

    直接比不同分辨率图的 lap_var 是错的：1024 图按像素算往往比 512 更「软」，
    但把它缩到同一尺寸后反而更锐。归一化后再比才有意义。
    """
    h, w = gray.shape
    s = max(h, w)
    if s <= 512:
        return gray
    scale = 512.0 / s
    im = Image.fromarray(np.clip(gray * 255.0, 0, 255).astype(np.uint8), mode="L")
    im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
    return np.asarray(im, dtype=np.float32) / 255.0


def _hf_ratio(gray):
    """2D FFT 高频能量占比：另一种「细节量」度量，对内容不敏感一些。"""
    g = gray.astype(np.float32)
    g = g - g.mean()
    h, w = g.shape
    s = min(h, w)
    if s < 32:
        return 0.0
    # 下采样到 <=512 加速 FFT，同时保留频谱形状
    step = max(1, s // 512)
    g = g[::step, ::step]
    g = g - g.mean()
    f = np.fft.fftshift(np.abs(np.fft.fft2(g)) ** 2)
    fy, fx = np.ogrid[-f.shape[0] // 2:f.shape[0] // 2, -f.shape[1] // 2:f.shape[1] // 2]
    r = np.sqrt((fy / (f.shape[0] / 2)) ** 2 + (fx / (f.shape[1] / 2)) ** 2)
    total = f.sum()
    if total <= 0:
        return 0.0
    return float(f[r > 0.25].sum() / total)


def _ahash(img):
    """8x8 均值哈希：用来找重复图（汉明距离 <=2 视为同一张的变体）。"""
    g = np.asarray(img.convert("L").resize((8, 8), Image.LANCZOS), dtype=np.float32)
    bits = (g > g.mean()).flatten()
    return "".join("1" if b else "0" for b in bits)


def metrics_of(path):
    img = _load(path)
    w, h = img.size
    arr = np.asarray(img, dtype=np.float32) / 255.0
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    gray = 0.299 * r + 0.587 * g + 0.114 * b

    lap_var = _lap_var(gray)
    lap512 = _lap_var(_gray512(gray))
    gvar = float((gray * 255.0).var())
    focus_ratio = lap_var / (gvar + 1e-6)

    gx = np.diff(gray, axis=1)
    gy = np.diff(gray, axis=0)
    mag = np.sqrt(gx[:-1, :] ** 2 + gy[:, :-1] ** 2)
    edge_pct = float((mag > 0.10).mean() * 100.0)

    # 九宫格局部锐度：暴露「只有主体清楚、四周糊成一团」
    tile_lap = []
    th, tw = max(1, h // 3), max(1, w // 3)
    for i in range(3):
        for j in range(3):
            tile = gray[i * th:(i + 1) * th, j * tw:(j + 1) * tw]
            if tile.size:
                tile_lap.append(_lap_var(tile))
    tile_lap = sorted(tile_lap) if tile_lap else [0.0]
    tile_min, tile_med, tile_max = tile_lap[0], tile_lap[len(tile_lap) // 2], tile_lap[-1]

    lum255 = (gray * 255.0)
    hist, _ = np.histogram(lum255, bins=256, range=(0, 256))
    p = hist / max(1, hist.sum())
    p = p[p > 0]
    entropy = float(-(p * np.log2(p)).sum())

    rg = r - g
    yb = 0.5 * (r + g) - b
    colorfulness = float(np.sqrt(rg.std() ** 2 + yb.std() ** 2) + 0.3 * np.sqrt(rg.mean() ** 2 + yb.mean() ** 2))

    px = (arr * 255.0)
    clip_hi = float((px.max(axis=2) >= 250).mean())
    clip_lo = float((px.max(axis=2) <= 5).mean())

    mp = (w * h) / 1e6
    verdict = _verdict(w, h, mp, lap_var, lap512, focus_ratio, edge_pct, clip_hi, clip_lo,
                       float(gray.std()), tile_min, tile_max)

    return {
        "path": os.path.abspath(path),
        "filename": os.path.basename(path),
        "width": w, "height": h, "megapixels": round(mp, 3),
        "bytes": os.path.getsize(path),
        "aspect": round(w / h, 4),
        "brightness": round(float(gray.mean()), 4),
        "contrast": round(float(gray.std()), 4),
        "saturation": round(float((arr.max(axis=2) - arr.min(axis=2)).mean()), 4),
        "colorfulness": round(colorfulness, 4),
        "entropy": round(entropy, 3),
        "lap_var": round(lap_var, 2),
        "lap_var_512": round(lap512, 2),
        "focus_ratio": round(focus_ratio, 5),
        "edge_pct": round(edge_pct, 2),
        "hf_ratio": round(_hf_ratio(gray), 4),
        "clip_high": round(clip_hi, 4),
        "clip_low": round(clip_lo, 4),
        "tile_lap_min": round(tile_min, 2),
        "tile_lap_med": round(tile_med, 2),
        "tile_lap_max": round(tile_max, 2),
        "ahash": _ahash(img),
        "verdict": verdict,
    }


def _verdict(w, h, mp, lap_var, lap512, focus_ratio, edge_pct, clip_hi, clip_lo, contrast, tmin, tmax):
    flags, notes, info = [], [], []

    if min(w, h) < 512:
        flags.append("tiny")
        notes.append(f"{w}x{h} 小于 512，几乎必然缺细节")
    elif mp < 0.5:
        flags.append("below_native")
        notes.append(f"{w}x{h}={mp:.2f}MP，低于 1MP 原生量级（FLUX/SD3 训练分辨率约 1MP）")
    elif mp < 0.75:
        flags.append("small")
        notes.append(f"{w}x{h}={mp:.2f}MP，接近但未达原生 1MP")

    if contrast < THRESHOLDS["flat_contrast"]:
        flags.append("flat")
        notes.append(f"灰度标准差 {contrast:.3f}，画面平板/发灰")
    if clip_hi > THRESHOLDS["clip_hi_bad"]:
        flags.append("clip_high")
        notes.append(f"{clip_hi*100:.1f}% 像素高光溢出（>=250）")
    if clip_lo > THRESHOLDS["clip_lo_bad"]:
        flags.append("clip_low")
        notes.append(f"{clip_lo*100:.1f}% 像素接近死黑（<=5）")

    # 用缩到 512 后的方差判定「糊」，跨分辨率可比
    if lap512 < THRESHOLDS["lap512_soft"]:
        flags.append("soft")
        notes.append(f"锐度偏低：归一化 lap512={lap512:.1f}（<{THRESHOLDS['lap512_soft']}）")
    if edge_pct < THRESHOLDS["edge_pct_soft"] and "soft" not in flags:
        flags.append("low_detail")
        notes.append(f"边缘像素仅 {edge_pct:.1f}%，细节密度低")

    # 九宫格差异常来自浅景深（人像/静物），只作提示，不参与判定
    if tmax > 50 and tmin / max(tmax, 1e-6) < THRESHOLDS["tile_ratio_soft"]:
        info.append(f"九宫格最糊/最锐 = {tmin/max(tmax,1e-6):.2f}（可能是浅景深，需看图确认）")

    if not flags:
        level = "ok"
        notes.append("客观指标无明显问题（审美与语义仍需看图判断）")
    elif any(f in flags for f in ("tiny", "below_native", "soft", "flat")):
        level = "risky"
    else:
        level = "warn"

    return {"level": level, "flags": flags, "notes": notes, "info": info,
            "native_resolution_ok": min(w, h) >= 768}


# ---------------------------------------------------------------- sheet
def _font(size):
    # 先找能显示中文的字体（标题/说明里有中文），否则英文标签也会变方块
    for p, idx in ((r"C:\Windows\Fonts\msyh.ttc", 0), (r"C:\Windows\Fonts\msyhbd.ttc", 0),
                   (r"C:\Windows\Fonts\simhei.ttf", 0),
                   (r"C:\Windows\Fonts\segoeui.ttf", 0)):
        try:
            return ImageFont.truetype(p, size, index=idx)
        except Exception:
            continue
    return ImageFont.load_default()


def _fit(draw, s, font, maxw):
    """按格宽截断文字，加省略号——否则多图标签会横向串行重叠。"""
    if draw.textlength(s, font=font) <= maxw:
        return s
    lo, hi = 0, len(s)
    while lo < hi:
        mid = (lo + hi) // 2
        if draw.textlength(s[:mid] + "…", font=font) <= maxw:
            lo = mid + 1
        else:
            hi = mid
    return s[:max(0, lo - 1)] + "…"


def make_sheet(paths, out, cols=2, cell=560, pad=10, label_h=76, meta=None):
    imgs = [_load(p) for p in paths]
    metas = [metrics_of(p) for p in paths]
    meta = meta or {}
    seeds = meta.get("seeds") or {}
    title = meta.get("title") or ""
    subtitle = meta.get("subtitle") or ""
    header_h = 62 if (title or subtitle) else 0

    rows = math.ceil(len(imgs) / cols)
    cell_w = cell
    cell_h = int(cell * max(i.size[1] / i.size[0] for i in imgs)) if imgs else cell
    cell_h = min(cell_h, cell * 2)
    W = cols * cell_w + (cols + 1) * pad
    H = header_h + rows * (cell_h + label_h) + (rows + 1) * pad
    sheet = Image.new("RGB", (W, H), (17, 19, 24))
    d = ImageDraw.Draw(sheet)
    f_big = _font(19)
    f_small = _font(15)
    f_tiny = _font(14)

    if header_h:
        d.text((pad + 2, 10), _fit(d, title, _font(21), W - pad * 2), font=_font(21), fill=(236, 240, 246))
        if subtitle:
            d.text((pad + 2, 37), _fit(d, subtitle, f_small, W - pad * 2), font=f_small, fill=(140, 150, 165))
        d.line([(pad, header_h - 10), (W - pad, header_h - 10)], fill=(45, 51, 63))

    for idx, (img, m) in enumerate(zip(imgs, metas)):
        c, r = idx % cols, idx // cols
        x = pad + c * (cell_w + pad)
        y = header_h + pad + r * (cell_h + label_h + pad)
        thumb = img.copy()
        thumb.thumbnail((cell_w, cell_h), Image.LANCZOS)
        ox = x + (cell_w - thumb.size[0]) // 2
        oy = y + (cell_h - thumb.size[1]) // 2
        sheet.paste(thumb, (ox, oy))
        d.rectangle([x - 1, y - 1, x + cell_w, y + cell_h], outline=(58, 66, 80))

        ly = y + cell_h + 6
        d.text((x + 2, ly), _fit(d, f"#{idx+1}  {m['filename']}", f_big, cell_w - 4), font=f_big, fill=(236, 240, 246))
        seed = seeds.get(m["filename"])
        seed_txt = f"seed={seed}  " if seed is not None else ""
        d.text((x + 2, ly + 24),
               _fit(d, f"{seed_txt}{m['width']}x{m['height']}  {m['megapixels']:.2f}MP  sharp512={m['lap_var_512']:.0f}  edge={m['edge_pct']:.1f}%", f_small, cell_w - 4),
               font=f_small, fill=(150, 158, 172))
        level = m['verdict']['level']
        flags = ",".join(m['verdict']['flags']) or "no-flag"
        color = (120, 195, 150) if level == 'ok' else (215, 165, 90) if level == 'warn' else (220, 120, 110)
        d.text((x + 2, ly + 46), _fit(d, f"{level.upper()}  {flags}", f_tiny, cell_w - 4), font=f_tiny, fill=color)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    if out.lower().endswith((".jpg", ".jpeg")):
        sheet.save(out, quality=90, subsampling=1)
    else:
        sheet.save(out)
    return {"out": os.path.abspath(out), "width": W, "height": H, "count": len(imgs), "metas": metas}


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    cmd = argv[1]

    def opt(name, default=None):
        return argv[argv.index(name) + 1] if name in argv else default

    files = [a for a in argv[2:] if not a.startswith("--")]
    # 去掉 --opt 的取值
    cleaned = []
    skip = False
    for i, a in enumerate(argv[2:]):
        if skip:
            skip = False
            continue
        if a.startswith("--"):
            if a in ("--json", "--out", "--cols", "--cell", "--meta", "--max", "--quality", "--in",
                     "--box", "--expand", "--feather", "--a", "--b", "--mask", "--grid", "--thr", "--tol",
                     "--place", "--canvas", "--region") and i + 1 < len(argv[2:]):
                skip = True
            continue
        cleaned.append(a)
    files = cleaned

    if cmd == "metrics":
        data = [metrics_of(p) for p in files]
        out = opt("--json", "-")
        s = json.dumps({"images": data}, ensure_ascii=False)
        if out == "-":
            sys.stdout.write(s + "\n")
        else:
            with open(out, "w", encoding="utf-8") as fh:
                fh.write(s)
            print(json.dumps({"json": os.path.abspath(out), "count": len(data)}))
        return 0

    if cmd == "sheet":
        out = opt("--out")
        if not out:
            print("sheet 需要 --out")
            return 2
        cols = int(opt("--cols", "2"))
        cell = int(opt("--cell", "560"))
        meta = None
        if opt("--meta"):
            with open(opt("--meta"), "r", encoding="utf-8") as fh:
                meta = json.load(fh)
        res = make_sheet(files, out, cols=cols, cell=cell, meta=meta)
        print(json.dumps(res, ensure_ascii=False))
        return 0

    if cmd == "thumb":
        src, out = opt("--in"), opt("--out")
        if not src or not out:
            print("thumb 需要 --in 与 --out")
            return 2
        max_side = int(opt("--max", "1280"))
        quality = int(opt("--quality", "92"))
        im = _load(src)
        if max(im.size) > max_side:
            im.thumbnail((max_side, max_side), Image.LANCZOS)
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        im.save(out, quality=quality, subsampling=1)
        print(json.dumps({"out": os.path.abspath(out), "width": im.size[0], "height": im.size[1]}))
        return 0

    if cmd == "mask":
        # 画局部重绘用的蒙版：白=要改，黑=不动
        src, out = opt("--in"), opt("--out")
        if not src or not out:
            print("mask 需要 --in 与 --out")
            return 2
        im = _load(src)
        w, h = im.size
        m = Image.new("L", (w, h), 0)
        d = ImageDraw.Draw(m)
        box = opt("--box")
        expand = int(opt("--expand", "8"))
        ellipse = "--ellipse" in argv
        if box:
            x, y, bw, bh = [int(v) for v in box.split(",")]
            x0, y0 = max(0, x - expand), max(0, y - expand)
            x1, y1 = min(w, x + bw + expand), min(h, y + bh + expand)
            if ellipse:
                d.ellipse([x0, y0, x1, y1], fill=255)
            else:
                d.rounded_rectangle([x0, y0, x1, y1], radius=max(4, expand), fill=255)
        else:
            d.rectangle([0, 0, w, h], fill=255)
        feather = int(opt("--feather", "12"))
        if feather > 0:
            m = m.filter(ImageFilter.GaussianBlur(feather))
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        m.save(out)
        white = float((np.asarray(m) > 127).mean())
        print(json.dumps({"out": os.path.abspath(out), "width": w, "height": h, "white_pct": round(white * 100, 2)}))
        return 0

    if cmd == "diff":
        # 验证「局部改动」是否真的局部：蒙版外的像素应当几乎不变
        a_path, b_path, mask_path = opt("--a"), opt("--b"), opt("--mask")
        if not (a_path and b_path):
            print("diff 需要 --a 与 --b")
            return 2
        a = _load(a_path)
        b = _load(b_path)
        if a.size != b.size:
            b = b.resize(a.size, Image.LANCZOS)
        aa = np.asarray(a, dtype=np.int16)
        bb = np.asarray(b, dtype=np.int16)
        delta = np.abs(aa - bb).max(axis=2)
        changed = delta > 8
        if mask_path and os.path.exists(mask_path):
            mk = np.asarray(_load(mask_path).convert("L"), dtype=np.uint8) > 127
        else:
            mk = np.ones(delta.shape, dtype=bool)
        inside = changed & mk
        outside = changed & (~mk)
        res = {
            "changed_pct_total": round(float(changed.mean()) * 100, 2),
            "changed_pct_inside_mask": round(float(inside.sum() / max(1, mk.sum())) * 100, 2),
            "changed_pct_outside_mask": round(float(outside.sum() / max(1, (~mk).sum())) * 100, 3),
            "mean_delta_inside": round(float(delta[mk].mean()), 2),
            "mean_delta_outside": round(float(delta[~mk].mean()), 3),
        }
        out_img = opt("--out")
        if out_img:
            heat = np.zeros((*delta.shape, 3), dtype=np.uint8)
            heat[..., 0] = np.clip(delta * 4, 0, 255)
            heat[..., 1] = np.clip(delta * 1, 0, 255)
            Image.fromarray(heat).save(out_img)
            res["out"] = os.path.abspath(out_img)
        print(json.dumps(res, ensure_ascii=False))
        return 0

    if cmd == "look":
        # 整体看：缩到能判断气质的大小；可选坐标网格，网格标签用「原图坐标」
        src, out = opt("--in"), opt("--out")
        if not src or not out:
            print("look 需要 --in 与 --out")
            return 2
        max_side = int(opt("--max", "900"))
        grid = int(opt("--grid", "0"))
        im = _load(src)
        W, H = im.size
        scale = min(1.0, max_side / max(W, H))
        small = im.resize((max(1, int(W * scale)), max(1, int(H * scale))), Image.LANCZOS).convert("RGB")
        if grid > 0:
            d = ImageDraw.Draw(small)
            f = _font(12)
            for x in range(grid, W, grid):
                sx = int(x * scale)
                d.line([(sx, 0), (sx, small.size[1])], fill=(255, 90, 90), width=1)
                d.text((sx + 2, 2), str(x), font=f, fill=(255, 220, 220))
            for y in range(grid, H, grid):
                sy = int(y * scale)
                d.line([(0, sy), (small.size[0], sy)], fill=(255, 90, 90), width=1)
                d.text((2, sy + 1), str(y), font=f, fill=(255, 220, 220))
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        small.save(out, quality=90, subsampling=1)
        print(json.dumps({"out": os.path.abspath(out), "width": W, "height": H,
                          "preview_width": small.size[0], "preview_height": small.size[1],
                          "scale": round(scale, 4), "grid": grid}, ensure_ascii=False))
        return 0

    if cmd == "region":
        # 细节看：裁一块再放大（坐标基于原图），用来看手/脸/文字/接缝
        src, out = opt("--in"), opt("--out")
        box = opt("--box")
        if not src or not out or not box:
            print("region 需要 --in --out --box x,y,w,h")
            return 2
        x, y, w, h = [int(v) for v in box.split(",")]
        max_side = int(opt("--max", "900"))
        im = _load(src)
        W, H = im.size
        x0, y0 = max(0, min(x, W - 1)), max(0, min(y, H - 1))
        x1, y1 = min(W, x0 + max(1, w)), min(H, y0 + max(1, h))
        crop = im.crop((x0, y0, x1, y1))
        s = min(4.0, max_side / max(1, max(crop.size)))
        crop = crop.resize((max(1, int(crop.size[0] * s)), max(1, int(crop.size[1] * s))), Image.LANCZOS)
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        crop.save(out, quality=92, subsampling=1)
        print(json.dumps({"out": os.path.abspath(out), "box": [x0, y0, x1 - x0, y1 - y0],
                          "width": crop.size[0], "height": crop.size[1], "scale": round(s, 3)}, ensure_ascii=False))
        return 0

    if cmd == "composite":
        # 把一张「参考渲染」贴进另一张图的指定区域（羽化边缘），用于「分开渲染 + 合成」
        base_path, patch_path, out = opt("--base"), opt("--patch"), opt("--out")
        box = opt("--box")
        if not (base_path and patch_path and out and box):
            print("composite 需要 --base --patch --out --box x,y,w,h")
            return 2
        x, y, w, h = [int(v) for v in box.split(",")]
        feather = int(opt("--feather", "12"))
        base = _load(base_path).convert("RGB")
        patch = _load(patch_path).convert("RGB").resize((w, h), Image.LANCZOS)
        mask = Image.new("L", (w, h), 255)
        if feather > 0:
            # 用向内的渐变做羽化：外圈半透明，中心全不透明
            m = Image.new("L", (w, h), 0)
            d = ImageDraw.Draw(m)
            d.rectangle([feather, feather, w - feather, h - feather], fill=255)
            mask = m.filter(ImageFilter.GaussianBlur(feather))
        base.paste(patch, (x, y), mask)
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        base.save(out, quality=95)
        print(json.dumps({"out": os.path.abspath(out), "box": [x, y, w, h], "feather": feather}))
        return 0

    if cmd == "place":
        # 为「把物体放进场景」准备两张图：控制图（场景边缘+物体边缘）与蒙版（区域 - 受保护的电线/结构）
        scene, obj = opt("--scene"), opt("--object")
        ctrl_out, mask_out = opt("--out-control"), opt("--out-mask")
        box = opt("--box")
        if not (scene and obj and ctrl_out and mask_out and box):
            print("place 需要 --scene --object --out-control --out-mask --box")
            return 2
        x, y, w, h = [int(v) for v in box.split(",")]
        feather = int(opt("--feather", "18"))
        protect = int(opt("--protect", "85")) / 100.0

        S = _load(scene).convert("RGB")
        W, H = S.size

        def edges(img, thr=0.08):
            g = np.asarray(img.convert("L"), dtype=np.float32) / 255.0
            gx, gy = np.gradient(g)
            m = np.hypot(gx, gy)
            return Image.fromarray(((m > thr) * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5))

        scene_e = edges(S)
        # 线稿场景处处是边缘，再用边缘做保护会把蒙版擦没；按边缘密度自动降保护
        edge_density = float((np.asarray(scene_e) > 0).mean())
        eff_protect = protect if edge_density < 0.08 else min(protect, 0.10)
        O = _load(obj).convert("RGB").resize((w, h), Image.LANCZOS)
        a = np.asarray(O, dtype=np.float32)
        alpha = np.clip((250.0 - a.min(axis=2)) / 30.0, 0, 1)
        obj_e = edges(O)

        canvas = np.asarray(scene_e).copy()
        oe = np.asarray(obj_e)
        reg = canvas[y:y + h, x:x + w]
        keep = alpha > 0.5
        # 区内先清空场景边缘（否则旧物体的轮廓会和新物体打架），只保留物体边缘
        reg[:] = 0
        reg[keep] = oe[keep]
        canvas[y:y + h, x:x + w] = reg
        # ControlNet 的 canny 先验是「白底黑线」。若输出黑底白线，模型会把「这是线稿」当成画面内容，
        # 整张图变成蓝图/工程图风（BUG-0018 的根因）。这里统一反相成白底黑线。
        canvas = ImageOps.invert(Image.fromarray(canvas).convert("RGB"))

        m = Image.new("L", (W, H), 0)
        d = ImageDraw.Draw(m)
        d.rectangle([max(0, x - 8), max(0, y - 8), min(W, x + w + 8), min(H, y + h + 8)], fill=255)
        if eff_protect > 0:
            prot = np.asarray(scene_e.filter(ImageFilter.MaxFilter(7)), dtype=np.float32) / 255.0
            mm = np.asarray(m, dtype=np.float32) * (1.0 - eff_protect * prot)
            m = Image.fromarray(mm.astype(np.uint8))
        if feather > 0:
            m = m.filter(ImageFilter.GaussianBlur(feather))

        os.makedirs(os.path.dirname(os.path.abspath(ctrl_out)), exist_ok=True)
        canvas.save(ctrl_out)
        m.save(mask_out)
        white = float((np.asarray(m) > 127).mean() * 100)
        print(json.dumps({"control": os.path.abspath(ctrl_out), "mask": os.path.abspath(mask_out),
                          "box": [x, y, w, h], "mask_white_pct": round(white, 2)}, ensure_ascii=False))
        return 0

    if cmd == "maskkey":
        # 用四角像素当背景色抠出主体，得到「贴合物体」的蒙版（比矩形框接缝小得多）
        src, out = opt("--in"), opt("--out")
        if not (src and out):
            print("maskkey 需要 --in 与 --out")
            return 2
        tol = float(opt("--tol", "22"))
        expand = int(opt("--expand", "8"))
        feather = int(opt("--feather", "20"))
        img = _load(src).convert("RGB")
        a = np.asarray(img, dtype=np.float32)
        # --region x,y,w,h：只在这块区域里找主体（场景图要在天空区域里抠旧飞机时用）
        region = opt("--region")
        rx, ry, rw, rh = [int(v) for v in region.split(",")] if region else (0, 0, int(a.shape[1]), int(a.shape[0]))
        rx2, ry2 = min(rx + rw, a.shape[1]), min(ry + rh, a.shape[0])
        sub = a[ry:ry2, rx:rx2]
        pad = 8
        corners = np.concatenate([
            sub[:pad, :pad].reshape(-1, 3), sub[:pad, -pad:].reshape(-1, 3),
            sub[-pad:, :pad].reshape(-1, 3), sub[-pad:, -pad:].reshape(-1, 3),
        ])
        bg = np.median(corners, axis=0)
        d = np.abs(a - bg).max(axis=2)
        m = ((d > tol) * 255).astype(np.uint8)
        # 区域外一律不算（否则整张画面里所有非背景色物体会被一起抠进去）
        if region:
            keep = np.zeros_like(m)
            keep[ry:ry2, rx:rx2] = m[ry:ry2, rx:rx2]
            m = keep
        # 边缘几个像素常有轻微渐晕/描边，会被当成主体 → 先清零，否则蒙版会多出一个「画框」
        m[:8, :] = 0
        m[-8:, :] = 0
        m[:, :8] = 0
        m[:, -8:] = 0
        mi = Image.fromarray(m)
        # 闭运算填掉主体内部的洞（浅色机身与背景色接近时会出现空洞）
        mi = mi.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.MinFilter(9))
        if expand > 0:
            mi = mi.filter(ImageFilter.MaxFilter(2 * expand + 1))
        if feather > 0:
            mi = mi.filter(ImageFilter.GaussianBlur(feather))
        # --place x,y,w,h：把抠出来的蒙版缩放并放到目标画布的指定位置（蒙版坐标必须和底图一致）
        place = opt("--place")
        canvas_spec = opt("--canvas")
        if place and canvas_spec:
            px, py, pw, ph = [int(v) for v in place.split(",")]
            cw, ch = [int(v) for v in canvas_spec.lower().split("x")]
            full = Image.new("L", (cw, ch), 0)
            full.paste(mi.resize((pw, ph), Image.LANCZOS), (px, py))
            mi = full
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        mi.save(out)
        white = float((np.asarray(mi) > 127).mean() * 100)
        print(json.dumps({"out": os.path.abspath(out), "bg": [int(v) for v in bg],
                          "white_pct": round(white, 2), "tol": tol}, ensure_ascii=False))
        return 0

    if cmd == "maskunion":
        # 两张蒙版取并集（旧物体轮廓 ∪ 新物体轮廓），再统一外扩/羽化。
        # 为什么要并集：只盖新物体时，旧轮廓会留在蒙版边界上，模型会顺着旧线继续画（BUG-0021）
        pa, pb, out = opt("--a"), opt("--b"), opt("--out")
        if not (pa and pb and out):
            print("maskunion 需要 --a --b --out")
            return 2
        expand = int(opt("--expand", "10"))
        feather = int(opt("--feather", "24"))
        A = np.asarray(_load(pa).convert("L"), dtype=np.uint8)
        B = np.asarray(_load(pb).convert("L"), dtype=np.uint8)
        if A.shape != B.shape:
            B = np.asarray(Image.fromarray(B).resize((A.shape[1], A.shape[0]), Image.LANCZOS), dtype=np.uint8)
        u = np.maximum(A, B)
        mi = Image.fromarray(u)
        if expand > 0:
            mi = mi.filter(ImageFilter.MaxFilter(2 * expand + 1))
        if feather > 0:
            mi = mi.filter(ImageFilter.GaussianBlur(feather))
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        mi.save(out)
        white = float((np.asarray(mi) > 127).mean() * 100)
        print(json.dumps({"out": os.path.abspath(out), "white_pct": round(white, 2),
                          "expand": expand, "feather": feather}, ensure_ascii=False))
        return 0

    if cmd == "edges":
        # 照片 → ControlNet 边缘控制图。默认「白底黑线」（canny 先验）；
        # --no-invert 保留黑底白线（会被模型读成线稿画风，见 BUG-0018）
        src, out = opt("--in"), opt("--out")
        if not (src and out):
            print("edges 需要 --in 与 --out")
            return 2
        thr = float(opt("--thr", "0.15"))
        img = _load(src).convert("RGB")
        g = np.asarray(img.convert("L"), dtype=np.float32) / 255.0
        gx, gy = np.gradient(g)
        m = np.hypot(gx, gy)
        mask = ((m > thr) * 255).astype(np.uint8)
        e = Image.fromarray(mask)
        # 略加粗（MaxFilter）：细线断点多，ControlNet 会把它读成破碎的纹理而不是结构
        e = e.filter(ImageFilter.MaxFilter(3)).convert("RGB")
        inverted = "--no-invert" not in argv
        if inverted:
            e = ImageOps.invert(e)
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        e.save(out)
        line_pct = float((np.asarray(e.convert("L")) < 128).mean() * 100)
        print(json.dumps({"out": os.path.abspath(out), "line_pct": round(line_pct, 2),
                          "inverted": inverted, "thr": thr}, ensure_ascii=False))
        return 0

    if cmd == "blur":  # 测试用：生成一张模糊图，验证度量能识别
        src, dst = files[0], files[1]
        _load(src).filter(ImageFilter.GaussianBlur(3)).save(dst)
        print(json.dumps({"out": os.path.abspath(dst)}))
        return 0

    print("unknown cmd: " + cmd)
    return 2


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main(sys.argv))
