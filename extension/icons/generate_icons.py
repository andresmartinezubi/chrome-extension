#!/usr/bin/env python3
"""Generate PNG icons for the Full Page Screenshot extension."""
import struct, zlib, os, math

def make_png(width, height, get_pixel):
    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xFFFFFFFF)

    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            raw.extend(get_pixel(x, y))

    sig  = b'\x89PNG\r\n\x1a\n'
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
    idat = chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    iend = chunk(b'IEND', b'')
    return sig + ihdr + idat + iend


def camera_pixel(px, py, size):
    s = float(size)
    nx, ny = px / s, py / s

    # --- palette ---
    BLUE       = (26,  115, 232, 255)
    BLUE_DARK  = (10,   80, 180, 255)
    LENS_INNER = (120, 190, 255, 255)
    CLEAR      = (0, 0, 0, 0)

    # Rounded-rect body: x [0.06, 0.94], y [0.28, 0.88], corner radius 0.12
    bx1, bx2 = 0.06, 0.94
    by1, by2 = 0.28, 0.88
    cr = 0.12

    def in_rounded_rect(nx, ny, x1, y1, x2, y2, r):
        if nx < x1 or nx > x2 or ny < y1 or ny > y2:
            return False
        corners = [(x1+r, y1+r), (x2-r, y1+r), (x1+r, y2-r), (x2-r, y2-r)]
        for cx, cy in corners:
            if nx < cx and ny < cy and math.hypot(nx-cx, ny-cy) > r:
                return False
            if nx < cx and ny > cy and math.hypot(nx-cx, ny-cy) > r:  # bottom-left
                pass
        # Simpler check: corners
        if nx < x1+r and ny < y1+r and math.hypot(nx-(x1+r), ny-(y1+r)) > r:
            return False
        if nx > x2-r and ny < y1+r and math.hypot(nx-(x2-r), ny-(y1+r)) > r:
            return False
        if nx < x1+r and ny > y2-r and math.hypot(nx-(x1+r), ny-(y2-r)) > r:
            return False
        if nx > x2-r and ny > y2-r and math.hypot(nx-(x2-r), ny-(y2-r)) > r:
            return False
        return True

    # Viewfinder bump: x [0.30, 0.70], y [0.12, 0.30], rounded
    bump_in = in_rounded_rect(nx, ny, 0.30, 0.12, 0.70, 0.30, 0.06)
    body_in = in_rounded_rect(nx, ny, bx1, by1, bx2, by2, cr)

    if not (body_in or bump_in):
        return CLEAR

    # Lens: circle center (0.50, 0.585), outer r=0.21, inner r=0.12
    lx, ly = 0.50, 0.585
    dist = math.hypot(nx - lx, ny - ly)
    if dist < 0.12:
        return LENS_INNER
    if dist < 0.21:
        return BLUE_DARK

    return BLUE


os.makedirs(os.path.dirname(os.path.abspath(__file__)), exist_ok=True)
script_dir = os.path.dirname(os.path.abspath(__file__))

for size in [16, 32, 48, 128]:
    data = make_png(size, size, lambda x, y, s=size: camera_pixel(x, y, s))
    path = os.path.join(script_dir, f'icon-{size}.png')
    with open(path, 'wb') as f:
        f.write(data)
    print(f'Created {path}')

print('Done.')
