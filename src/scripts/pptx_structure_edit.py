"""Structural PPTX edits that the existing edit_pptx.py intentionally rejects.

Operations (plan["ops"], applied in order):
  add_slide   insert one content slide that reuses an existing slide's frame
  font_size   change font sizes of title / body / table text
  fill_slide  write a title and body into an existing empty slide

Existing slides are never re-generated. Only the inserted slide, or the
runs whose size is changed, differ from the input file.
"""
import argparse
import json
import re
import sys
from copy import deepcopy

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE_TYPE, PP_PLACEHOLDER
from pptx.enum.shapes import MSO_AUTO_SHAPE_TYPE
from pptx.oxml.ns import qn
from pptx.util import Emu, Pt

MIN_PT = 10
MAX_PT = 44
DEFAULT_BODY_PT = 18
DEFAULT_TITLE_PT = 28
FOOTER_TYPES = {PP_PLACEHOLDER.SLIDE_NUMBER, PP_PLACEHOLDER.FOOTER, PP_PLACEHOLDER.DATE}
TITLE_TYPES = {PP_PLACEHOLDER.TITLE, PP_PLACEHOLDER.CENTER_TITLE}
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def placeholder_type(shape):
    try:
        return shape.placeholder_format.type if shape.is_placeholder else None
    except Exception:
        return None


def shape_text(shape) -> str:
    # Read the XML directly: shape.text_frame adds an empty <p:txBody> to
    # autoshapes without text, which would modify slides we only inspect.
    body = shape._element.find(qn("p:txBody"))
    if body is None:
        return ""
    return "".join(t.text or "" for t in body.iter(qn("a:t"))).strip()


def same(a, b) -> bool:
    # python-pptx returns a new proxy object on every access; compare elements.
    return a is not None and b is not None and a._element is b._element


class RefFont:
    """Read-only run formatting. python-pptx's run.font adds an <a:rPr/> to
    runs that lack one, which would modify the slides we only read from."""

    def __init__(self, run):
        rpr = run._r.find(qn("a:rPr"))
        sz = rpr.get("sz") if rpr is not None else None
        self.size = Pt(int(sz) / 100) if sz and sz.isdigit() else None
        latin = rpr.find(qn("a:latin")) if rpr is not None else None
        self.name = latin.get("typeface") if latin is not None and not str(latin.get("typeface", "")).startswith("+") else None
        srgb = rpr.find(qn("a:solidFill") + "/" + qn("a:srgbClr")) if rpr is not None else None
        self.rgb = RGBColor.from_string(srgb.get("val")) if srgb is not None and len(srgb.get("val", "")) == 6 else None


def max_run_pt(shape) -> float:
    best = 0.0
    if getattr(shape, "has_text_frame", False) and shape.has_text_frame:
        for p in shape.text_frame.paragraphs:
            for r in p.runs:
                size = RefFont(r).size
                if size:
                    best = max(best, size.pt)
    return best


def is_footer_like(shape, slide_h: int) -> bool:
    if placeholder_type(shape) in FOOTER_TYPES:
        return True
    text = shape_text(shape)
    top = shape.top or 0
    return bool(text) and top > slide_h * 0.88 and len(text) <= 40


def find_title(slide, slide_h: int):
    for shape in slide.shapes:
        if placeholder_type(shape) in TITLE_TYPES and shape_text(shape):
            return shape
    # Without a title placeholder, the slide heading is the top-most text in the
    # header area; a larger heading lower down is a body column heading.
    candidates = [s for s in slide.shapes if shape_text(s) and (s.top or 0) < slide_h * 0.2 and not is_footer_like(s, slide_h)]
    if not candidates:
        # Cover slides center their title: fall back to the largest text.
        texts = [s for s in slide.shapes if shape_text(s) and not is_footer_like(s, slide_h) and max_run_pt(s) >= 24]
        return max(texts, key=max_run_pt) if texts else None
    return min(candidates, key=lambda s: (round((s.top or 0) / (slide_h * 0.03)), -max_run_pt(s)))


def is_edge_decoration(shape, slide_w: int, slide_h: int) -> bool:
    """Thin bars/lines touching a slide edge belong to the frame, not the body."""
    if shape_text(shape):
        return False
    left, top = shape.left or 0, shape.top or 0
    width, height = shape.width or 0, shape.height or 0
    thin = width <= slide_w * 0.03 or height <= slide_h * 0.03
    touches = left <= slide_w * 0.02 or top <= slide_h * 0.02 or left + width >= slide_w * 0.98 or top + height >= slide_h * 0.98
    return thin and touches


def body_text_shapes(slide, slide_h: int):
    title = find_title(slide, slide_h)
    return [s for s in slide.shapes if not same(s, title) and shape_text(s) and not is_footer_like(s, slide_h)]


def first_run_font(shapes):
    for shape in shapes:
        for p in shape.text_frame.paragraphs:
            for r in p.runs:
                if r.text.strip():
                    return RefFont(r)
    return None


def choose_reference(prs, slide_h: int):
    """Prefer a middle content slide that has a title and body text."""
    slides = list(prs.slides)
    # The cover (first slide) is the last resort: its frame differs from content slides.
    ordered = slides[1:-1] + slides[-1:] + slides[:1] if len(slides) > 2 else slides[1:] + slides[:1]
    for slide in ordered:
        if find_title(slide, slide_h) is not None and body_text_shapes(slide, slide_h):
            return slide
    for slide in ordered:
        if find_title(slide, slide_h) is not None:
            return slide
    return slides[0] if slides else None


def move_slide(prs, old_index: int, new_index: int):
    ids = prs.slides._sldIdLst
    items = list(ids)
    element = items[old_index]
    ids.remove(element)
    ids.insert(new_index, element)


def clone_frame(prs, ref, slide_h: int):
    """Copy the reference slide's frame (background, header band, logo, footer)
    but drop its body content, title text and charts."""
    new = prs.slides.add_slide(ref.slide_layout)
    for shape in list(new.shapes):
        shape._element.getparent().remove(shape._element)
    rid_map = {}
    for rid, rel in ref.part.rels.items():
        if rel.reltype.endswith("/slideLayout") or rel.reltype.endswith("/notesSlide") or rel.reltype.endswith("/chart"):
            continue
        if rel.is_external:
            rid_map[rid] = new.part.relate_to(rel.target_ref, rel.reltype, is_external=True)
        else:
            rid_map[rid] = new.part.relate_to(rel.target_part, rel.reltype)
    bg = ref._element.cSld.find(qn("p:bg"))
    if bg is not None:
        new._element.cSld.insert(0, deepcopy(bg))
    title = find_title(ref, slide_h)
    title_bottom = (title.top + title.height) if title is not None else int(slide_h * 0.18)
    body_top = title_bottom
    for shape in ref.shapes:
        # Tables/charts (graphic frames, also inside groups) are body content, and
        # chart parts must not be shared between slides.
        if any(True for _ in shape._element.iter(qn("p:graphicFrame"))):
            continue
        top = shape.top or 0
        is_title = same(shape, title)
        keep = (is_title or is_footer_like(shape, slide_h) or top + (shape.height or 0) <= body_top
                or top >= slide_h * 0.9 or is_edge_decoration(shape, prs.slide_width, slide_h)
                or (not shape_text(shape) and top < slide_h * 0.2 and (shape.height or 0) <= slide_h * 0.03))
        if not keep:
            continue
        element = deepcopy(shape._element)
        for node in element.iter():
            for attr in list(node.attrib):
                if attr.startswith("{" + REL_NS + "}") and node.attrib[attr] in rid_map:
                    node.attrib[attr] = rid_map[node.attrib[attr]]
        new.shapes._spTree.append(element)
    return new, body_top


def new_title_shape(slide, slide_h: int):
    return find_title(slide, slide_h)


def set_shape_text(shape, text: str):
    tf = shape.text_frame
    first = tf.paragraphs[0]
    keep_rpr = None
    if first.runs and first.runs[0]._r.find(qn("a:rPr")) is not None:
        keep_rpr = deepcopy(first.runs[0]._r.find(qn("a:rPr")))
    for p in list(tf.paragraphs)[1:]:
        p._p.getparent().remove(p._p)
    for r in list(first.runs):
        r._r.getparent().remove(r._r)
    run = first.add_run()
    run.text = text
    if keep_rpr is not None:
        old = run._r.find(qn("a:rPr"))
        if old is not None:
            run._r.remove(old)
        run._r.insert(0, keep_rpr)


def apply_font(run, ref_font, size_pt: float, bold=None):
    run.font.size = Pt(size_pt)
    if ref_font is not None:
        if ref_font.name:
            run.font.name = ref_font.name
        if ref_font.rgb is not None:
            run.font.color.rgb = ref_font.rgb
    if bold is not None:
        run.font.bold = bold


def text_units(text: str) -> float:
    # Full-width characters take one em, ASCII roughly half.
    return sum(1.0 if ord(ch) > 0x2E7F else 0.55 for ch in text)


def lines_needed(texts, width_emu: int, size_pt: float, indent_em: float = 1.2) -> int:
    per_line = max(4.0, Emu(width_emu).pt / size_pt - indent_em)
    return sum(max(1, -(-int(text_units(t) * 100) // int(per_line * 100))) for t in texts)


def fit_bullets(bullets, width: int, height: int, start_pt: float):
    """Return (size, kept_bullets, omitted_count); never silently truncates text."""
    size = start_pt
    kept = list(bullets)
    while True:
        need = lines_needed(kept, width, size) * size * 1.45 + len(kept) * size * 0.4
        if need <= Emu(height).pt:
            return size, kept, len(bullets) - len(kept)
        if size > 12:
            size -= 1
            continue
        if len(kept) <= 1:
            return size, kept, len(bullets) - len(kept)
        kept = kept[:-1]


def add_bullets_box(slide, left, top, width, height, bullets, ref_font, start_pt):
    size, kept, omitted = fit_bullets(bullets, width, height, start_pt)
    box = slide.shapes.add_textbox(left, top, width, height)
    box.name = "AzureChat Added Body"
    tf = box.text_frame
    tf.word_wrap = True
    for i, text in enumerate(kept):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        ppr = p._p.get_or_add_pPr()
        ppr.set("marL", str(int(Pt(size * 1.2))))
        ppr.set("indent", str(-int(Pt(size * 1.2))))
        bu = ppr.makeelement(qn("a:buChar"), {"char": "•"})
        ppr.append(bu)
        p.space_after = Pt(size * 0.4)
        run = p.add_run()
        run.text = text
        apply_font(run, ref_font, size)
    return box, size, omitted


def font_rgb(font):
    return font.rgb if font is not None else None


def add_table(slide, left, top, width, height, columns, rows, ref_font, start_pt, header_rgb=None):
    columns = [str(c)[:30] for c in columns][:5]
    rows = [[str(c)[:80] for c in row][: len(columns)] + [""] * max(0, len(columns) - len(row)) for row in rows][:6]
    size = min(start_pt, 14)
    while size > MIN_PT:
        row_lines = [max(lines_needed([cell], width // len(columns), size, 0.6) for cell in row) for row in rows]
        need = (sum(row_lines) + 1) * size * 1.5 + (len(rows) + 1) * size * 0.6
        if need <= Emu(height).pt:
            break
        size -= 1
    row_h = int(Pt(size * 2.1))
    shape = slide.shapes.add_table(len(rows) + 1, len(columns), left, top, width, min(height, row_h * (len(rows) + 1)))
    shape.name = "AzureChat Added Table"
    table = shape.table
    for c, name in enumerate(columns):
        cell = table.cell(0, c)
        cell.text = name
        if header_rgb is not None:
            # Match the deck's heading color instead of the theme's default blue.
            cell.fill.solid()
            cell.fill.fore_color.rgb = header_rgb
        for p in cell.text_frame.paragraphs:
            for r in p.runs:
                apply_font(r, None, size, bold=True)
                if ref_font is not None and ref_font.name:
                    r.font.name = ref_font.name
    for r_i, row in enumerate(rows, start=1):
        for c, value in enumerate(row):
            cell = table.cell(r_i, c)
            cell.text = value
            for p in cell.text_frame.paragraphs:
                for run in p.runs:
                    # Keep the table style's text colors (readable on its row fills).
                    apply_font(run, None, size)
                    if ref_font is not None and ref_font.name:
                        run.font.name = ref_font.name
    return shape, size


def add_sources(slide, left, top, width, sources, ref_font):
    box = slide.shapes.add_textbox(left, top, width, Pt(14 * max(1, len(sources))))
    box.name = "AzureChat Added Sources"
    tf = box.text_frame
    tf.word_wrap = True
    for i, src in enumerate(sources[:3]):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        run = p.add_run()
        label = str(src.get("label") or src.get("url"))[:80]
        run.text = ("出典: " if i == 0 else "　　  ") + label
        apply_font(run, ref_font, 9)
        url = str(src.get("url") or "")
        if re.match(r"^https?://", url):
            run.hyperlink.address = url
    return box


def company_card_column(columns):
    return next((i for i, name in enumerate(columns) if re.search(r"企業|会社|プレイヤー", str(name))), None)


def add_company_cards(slide, left, top, width, height, columns, rows, ref_font, header_rgb=None):
    """Small company lists use editable cards; all source cells remain visible.

    Preserve supplied labels, including rank labels, rather than inventing an
    ordering. Numeric/general comparison tables retain the existing table path.
    """
    name_col = company_card_column(columns)
    primary = header_rgb or RGBColor.from_string("104F60")
    accent = primary
    for shape in slide.shapes:
        fill = shape._element.find(qn("p:spPr") + "/" + qn("a:solidFill") + "/" + qn("a:srgbClr"))
        if fill is not None:
            value = fill.get("val", "")
            if re.fullmatch(r"[0-9a-fA-F]{6}", value):
                rgb = RGBColor.from_string(value)
                if max(rgb) > 160 and min(rgb) < 140 and max(rgb) - min(rgb) > 40:
                    accent = rgb
                    break
    gap = int(width * 0.025)
    count = len(rows)
    cols = 3 if count >= 3 else count
    nrows = (count + cols - 1) // cols
    card_w = (width - gap * (cols - 1)) // cols
    card_h = (height - gap * (nrows - 1)) // nrows

    def text_box(x, y, w, h, text, size, color, bold=False):
        box = slide.shapes.add_textbox(int(x), int(y), int(w), int(h))
        box.name = "AzureChat Company Card Text"
        tf = box.text_frame
        tf.word_wrap = True
        tf.margin_left = tf.margin_right = 0
        tf.margin_top = tf.margin_bottom = 0
        run = tf.paragraphs[0].add_run()
        run.text = text
        apply_font(run, ref_font, size, bold)
        run.font.color.rgb = color
        return box

    for i, row in enumerate(rows):
        r, c = divmod(i, cols)
        row_count = min(cols, count - r * cols)
        offset = (width - (card_w * row_count + gap * (row_count - 1))) // 2
        x, y = left + offset + c * (card_w + gap), top + r * (card_h + gap)
        card = slide.shapes.add_shape(MSO_AUTO_SHAPE_TYPE.ROUNDED_RECTANGLE, x, y, card_w, card_h)
        card.name = "AzureChat Company Card"
        card.fill.solid()
        card.fill.fore_color.rgb = RGBColor(255, 255, 255)
        card.line.color.rgb = RGBColor.from_string("DCE8EC")
        card.line.width = Pt(1)
        pad = int(card_w * 0.07)
        stripe = slide.shapes.add_shape(MSO_AUTO_SHAPE_TYPE.RECTANGLE, x + pad, y + pad, int(card_w * 0.2), Pt(4))
        stripe.fill.solid()
        stripe.fill.fore_color.rgb = accent
        stripe.line.fill.background()
        name = str(row[name_col]) if name_col < len(row) else ""
        details = "\n".join(f"{label}：{row[j]}" for j, label in enumerate(columns) if j != name_col and j < len(row) and str(row[j]).strip())
        inner_w = card_w - 2 * pad
        title_h = int(card_h * 0.30)
        name_size = 18
        while name_size > 12 and lines_needed([name], inner_w, name_size, 0) * name_size * 1.3 > Emu(title_h).pt:
            name_size -= 1
        text_box(x + pad, y + pad + Pt(10), inner_w, title_h, name, name_size, primary, True)
        body_y = y + pad + Pt(10) + title_h
        body_h = max(Pt(16), y + card_h - pad - body_y)
        size = 14
        while size > 10 and lines_needed(details.split("\n"), inner_w, size, 0) * size * 1.35 > Emu(body_h).pt:
            size -= 1
        text_box(x + pad, body_y, inner_w, body_h, details, size, RGBColor.from_string("52666E"))


def write_content(slide, slide_w, slide_h, body_top, op, ref_body_font, warnings, slide_no, header_rgb=None):
    margin_x = int(slide_w * 0.06)
    left, width = margin_x, slide_w - margin_x * 2
    top = body_top + int(slide_h * 0.03)
    sources = [s for s in (op.get("sources") or []) if isinstance(s, dict) and s.get("url")]
    bottom = int(slide_h * 0.88) - (int(Pt(14 * min(3, len(sources)) + 6)) if sources else 0)
    height = max(int(slide_h * 0.2), bottom - top)
    ref_size = ref_body_font.size.pt if ref_body_font is not None and ref_body_font.size else DEFAULT_BODY_PT
    ref_size = max(MIN_PT, min(24, ref_size))
    if op.get("kind") == "table" and op.get("table"):
        table = op["table"]
        columns, rows = table.get("columns") or [], table.get("rows") or []
        if company_card_column(columns) is not None and 1 <= len(rows) <= 6 and len(columns) <= 3:
            add_company_cards(slide, left, top, width, height, columns, rows, ref_body_font, header_rgb)
        else:
            add_table(slide, left, top, width, height, columns, rows, ref_body_font, ref_size, header_rgb)
        if len(table.get("rows") or []) > 6 or len(table.get("columns") or []) > 5:
            warnings.append(f"P{slide_no}: 表は6行×5列までのため、超えた行・列を省略しました。")
    elif op.get("bullets"):
        bullets = [str(b).strip() for b in op["bullets"] if str(b).strip()][:6]
        _, _, omitted = add_bullets_box(slide, left, top, width, height, bullets, ref_body_font, ref_size)
        if len(op["bullets"]) > 6:
            omitted += len(op["bullets"]) - 6
        if omitted:
            warnings.append(f"P{slide_no}: 収まらないため箇条書き{omitted}項目を省略しました。")
    if sources:
        add_sources(slide, left, bottom + int(Pt(4)), width, sources, ref_body_font)


def op_add_slide(prs, op, warnings):
    slide_w, slide_h = prs.slide_width, prs.slide_height
    ref = choose_reference(prs, slide_h)
    if ref is None:
        raise ValueError("参照できるスライドがありません。")
    ref_body_font = first_run_font(body_text_shapes(ref, slide_h))
    new, body_top = clone_frame(prs, ref, slide_h)
    title = new_title_shape(new, slide_h)
    title_text = str(op.get("title") or "").strip()[:60]
    if title is not None:
        set_shape_text(title, title_text)
    elif title_text:
        box = new.shapes.add_textbox(int(slide_w * 0.06), int(slide_h * 0.05), int(slide_w * 0.88), int(slide_h * 0.12))
        run = box.text_frame.paragraphs[0].add_run()
        run.text = title_text
        apply_font(run, ref_body_font, DEFAULT_TITLE_PT, bold=True)
    count = len(prs.slides)
    position = op.get("position")
    if isinstance(position, int) and position < 0:
        position = count + position  # -2 = second from the end, counting the new slide
    position = count - 1 if not isinstance(position, int) else max(0, min(position, count - 1))
    for shape in new.shapes:
        text = shape_text(shape)
        if is_footer_like(shape, slide_h) and re.fullmatch(r"\d{1,3}", text):
            set_shape_text(shape, str(position + 1))
    if not op.get("blank"):
        header_rgb = font_rgb(first_run_font([title])) if title is not None else None
        write_content(new, slide_w, slide_h, body_top, op, ref_body_font, warnings, position + 1, header_rgb)
    move_slide(prs, count - 1, position)
    return position


def is_empty_slide(slide, slide_h: int) -> bool:
    return not any(shape_text(s) for s in slide.shapes if not is_footer_like(s, slide_h)) and not any(
        s.shape_type in (MSO_SHAPE_TYPE.TABLE, MSO_SHAPE_TYPE.CHART) or getattr(s, "has_table", False) for s in slide.shapes
    )


def op_fill_slide(prs, op, warnings):
    slide_w, slide_h = prs.slide_width, prs.slide_height
    index = op.get("slideIndex")
    slides = list(prs.slides)
    if not isinstance(index, int) or not 0 <= index < len(slides):
        raise ValueError("指定したスライドがありません。")
    slide = slides[index]
    if not is_empty_slide(slide, slide_h):
        raise ValueError(f"P{index + 1}は空白スライドではないため、本文を書き込みませんでした。")
    ref = choose_reference(prs, slide_h)
    ref_body_font = first_run_font(body_text_shapes(ref, slide_h)) if ref is not None and not same(ref, slide) else None
    title_text = str(op.get("title") or "").strip()[:60]
    title_ph = next((s for s in slide.placeholders if placeholder_type(s) in TITLE_TYPES), None)
    body_top = int(slide_h * 0.2)
    if title_ph is not None:
        if title_text:
            title_ph.text_frame.text = title_text
        body_top = title_ph.top + title_ph.height
    elif title_text:
        ref_title = find_title(ref, slide_h) if ref is not None and not same(ref, slide) else None
        geo = (ref_title.left, ref_title.top, ref_title.width, ref_title.height) if ref_title is not None else (
            int(slide_w * 0.06), int(slide_h * 0.05), int(slide_w * 0.88), int(slide_h * 0.12))
        box = slide.shapes.add_textbox(*geo)
        box.name = "AzureChat Added Title"
        run = box.text_frame.paragraphs[0].add_run()
        run.text = title_text
        ref_title_font = first_run_font([ref_title]) if ref_title is not None else None
        apply_font(run, ref_title_font, ref_title_font.size.pt if ref_title_font is not None and ref_title_font.size else DEFAULT_TITLE_PT, bold=True)
        body_top = geo[1] + geo[3]
    body_ph = next((s for s in slide.placeholders if placeholder_type(s) not in TITLE_TYPES | FOOTER_TYPES), None)
    if body_ph is not None and op.get("bullets") and op.get("kind") != "table":
        body_ph._element.getparent().remove(body_ph._element)
        body_top = max(body_top, body_ph.top - int(slide_h * 0.03))
    write_content(slide, slide_w, slide_h, body_top, op, ref_body_font, warnings, index + 1)
    return index


def resize_runs(shape, mode, value, default_pt, sizes):
    for p in shape.text_frame.paragraphs:
        for r in p.runs:
            if not r.text.strip():
                continue
            base = r.font.size.pt if r.font.size else default_pt
            size = value if mode == "absolute" else base + value
            size = max(MIN_PT, min(MAX_PT, size))
            r.font.size = Pt(size)
            sizes.append(size)


def overflows(shape) -> bool:
    if not shape.has_text_frame or not shape.width or not shape.height:
        return False
    texts, size = [], 0.0
    for p in shape.text_frame.paragraphs:
        texts.append(p.text or " ")
        for r in p.runs:
            if r.font.size:
                size = max(size, r.font.size.pt)
    size = size or DEFAULT_BODY_PT
    return lines_needed(texts, shape.width, size, 0.4) * size * 1.25 > Emu(shape.height).pt * 1.05


def op_font_size(prs, op, warnings):
    slide_h = prs.slide_height
    scope = op.get("scope") or "all"
    mode = "absolute" if op.get("mode") == "absolute" else "relative"
    value = float(op.get("value") or 0)
    if mode == "absolute" and not MIN_PT <= value <= MAX_PT:
        warnings.append(f"{value:g}ptは範囲外のため、{MIN_PT}〜{MAX_PT}ptに収めました。")
    targets = op.get("slides")
    changed, overflow = [], []
    for index, slide in enumerate(prs.slides):
        if isinstance(targets, list) and targets and index not in targets:
            continue
        title = find_title(slide, slide_h)
        sizes = []
        for shape in slide.shapes:
            if shape.shape_type == MSO_SHAPE_TYPE.PICTURE or is_footer_like(shape, slide_h):
                continue
            if getattr(shape, "has_table", False) and shape.has_table:
                if scope in ("table", "all"):
                    for row in shape.table.rows:
                        for cell in row.cells:
                            resize_runs(cell, mode, value, 14, sizes)
                continue
            if not shape_text(shape):
                continue
            is_title = same(shape, title)
            if (scope == "title" and is_title) or (scope == "body" and not is_title) or scope == "all":
                resize_runs(shape, mode, value, DEFAULT_TITLE_PT if is_title else DEFAULT_BODY_PT, sizes)
                if overflows(shape):
                    overflow.append(index + 1)
        if sizes:
            changed.append(index)
    if overflow:
        warnings.append("文字が枠からはみ出す可能性があります: " + "、".join(f"P{n}" for n in sorted(set(overflow))))
    return changed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--plan", required=True)
    args = parser.parse_args()
    with open(args.plan, encoding="utf-8") as f:
        plan = json.load(f)
    prs = Presentation(args.input)
    before = len(prs.slides)
    try:
        warnings, changed, added = apply_ops(prs, plan)
    except ValueError as error:
        # Expected refusals (e.g. target slide is not empty): nothing is saved.
        print(json.dumps({"ok": False, "error": str(error)}))
        sys.exit(3)
    prs.save(args.output)
    # Keys follow edit_pptx.py so the route's runPythonEdit can read them.
    print(json.dumps({
        "ok": True,
        "slidesBefore": before,
        "totalSlides": len(prs.slides),
        "addedSlides": added,
        "changedSlides": len(set(changed)),
        "changedSlideIndices": sorted(set(changed)),
        "layoutWarnings": warnings,
    }))  # ASCII-escaped: Windows consoles would otherwise re-encode Japanese.


def apply_ops(prs, plan):
    warnings, changed, added = [], [], 0
    for op in plan.get("ops") or []:
        kind = op.get("type")
        if kind == "add_slide":
            if added >= 3:
                warnings.append("1回の依頼で追加できるのは3枚までのため、4枚目以降は追加していません。")
                continue
            index = op_add_slide(prs, op, warnings)
            changed = [i + 1 if i >= index else i for i in changed] + [index]
            added += 1
        elif kind == "fill_slide":
            changed.append(op_fill_slide(prs, op, warnings))
        elif kind == "font_size":
            changed.extend(op_font_size(prs, op, warnings))
    return warnings, changed, added


if __name__ == "__main__":
    main()
