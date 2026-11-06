from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
for size in (192, 512):
    scale = size / 192
    image = Image.new("RGB", (size, size), "#f7f7f7")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=44 * scale, fill="#161616")
    points = [(48, 132), (91, 53), (101, 53), (144, 132)]
    draw.line([(round(x * scale), round(y * scale)) for x, y in points], fill="white", width=round(11 * scale), joint="curve")
    draw.line((round(67 * scale), round(102 * scale), round(126 * scale), round(102 * scale)), fill="white", width=round(11 * scale))
    draw.ellipse((round(128 * scale), round(49 * scale), round(144 * scale), round(65 * scale)), fill="#a1a1a1")
    image.save(root / "web" / f"icon-{size}.png")
