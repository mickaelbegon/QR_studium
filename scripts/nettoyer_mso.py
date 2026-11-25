#!/usr/bin/env python3
"""Nettoie le balisage hérité de Word / OnlyOffice (« MSO ») d'une banque Moodle XML.

Usage :
    python -I scripts/nettoyer_mso.py <entrée.xml> <sortie.xml> [rapport.md]
    python -I scripts/nettoyer_mso.py --autotest

Principes :
- seul le HTML contenu dans les balises <text>…</text> est modifié, par
  substitution ciblée dans le texte du fichier (aucune re-sérialisation XML) ;
  tout le reste (structure, <file> en base64, indentation) est recopié tel quel ;
- un champ sans balisage à nettoyer ressort identique octet pour octet ;
- le texte lisible n'est jamais modifié : après nettoyage, le script vérifie pour
  chaque champ que le texte brut est identique, sinon le champ est laissé intact
  et signalé ;
- bibliothèque standard seulement ; le fichier d'entrée n'est jamais modifié.
"""
import bisect
import collections
import hashlib
import html
import io
import os
import re
import sys
import xml.etree.ElementTree as ET

# --------------------------------------------------------------------------
# Analyse lexicale du HTML
# --------------------------------------------------------------------------

# commentaire | marqueur conditionnel <![if …]> / <![endif]> | balise
TOKEN = re.compile(
    r'<!--.*?-->'
    r'|<!\[[^\]<>]*\]>'
    r'|<(/?)([A-Za-z][A-Za-z0-9:_.-]*)((?:"[^"]*"|\'[^\']*\'|[^<>"\'])*)>',
    re.S)
ATTR = re.compile(r'\s+([^\s=<>/"\']+)(?:\s*=\s*("[^"]*"|\'[^\']*\'|[^\s"\'<>]+))?')
DECL = re.compile(r'(?:&[#\w]+;|[^;])+')

VOID = {'br', 'img', 'hr', 'col', 'meta', 'link', 'input', 'area', 'base',
        'embed', 'param', 'source', 'track', 'wbr'}
BLOCK = {'p', 'div', 'table', 'ul', 'ol', 'li', 'tr', 'td', 'th', 'h1', 'h2',
         'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'hr', 'tbody', 'thead',
         'dl', 'section', 'article', 'figure'}
OFFICE_NS = ('o:', 'w:', 'm:', 'st1:')
BOLD_TAGS = {'b', 'strong', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'}
ITAL_TAGS = {'i', 'em', 'cite', 'var', 'address', 'dfn'}
FSIZE_TAGS = {'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'sub', 'sup', 'small', 'big'}
WRAPPABLE = {'span', 'p'}          # balises où font-weight/font-style -> <strong>/<em>
ASCII_WS = ' \t\r\n\f'

WORD_UNIT = re.compile(r'\d\s*(pt|cm|mm|in|pc)\b', re.I)
BLACK = re.compile(
    r'^(black|windowtext|#000|#000000|rgb\(\s*0\s*,?\s*0\s*,?\s*0\s*\)'
    r'|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*1(\.0*)?\s*\))$', re.I)
WHITE = re.compile(
    r'^(white|#fff|#ffffff|transparent|none|initial'
    r'|rgb\(\s*255\s*,?\s*255\s*,?\s*255\s*\))$', re.I)
BG_DEFAULTS = {
    'background-position': {'0% 0%', '0 0', 'initial'},
    'background-repeat': {'repeat', 'initial'},
    'background-attachment': {'scroll', 'initial'},
    'background-image': {'none', 'initial'},
    'background-size': {'auto', 'initial'},
    'background-origin': {'padding-box', 'initial'},
    'background-clip': {'border-box', 'initial'},
}
WORD_PROPS = {'tab-stops', 'text-autospace', 'punctuation-wrap',
              'layout-grid-mode', 'text-justify', 'text-kashida-space'}
MARGIN_PROPS = {'margin', 'margin-top', 'margin-right', 'margin-bottom',
                'margin-left', 'text-indent'}
WORD_ANCHOR = re.compile(r'^_(Hlk|Toc|Ref|GoBack|Hlt)', re.I)

# Libellés des catégories du rapport
C_COMMENT = 'commentaires HTML (y compris conditionnels)'
C_COND = 'marqueurs conditionnels <![if …]> / <![endif]>'
C_BLOCK = 'blocs <xml> / <style>'
C_OFFICE = 'balises Office (<o:…>, <w:…>, <m:…>, <st1:…>)'
C_MSOCLASS = 'classes Mso*'
C_DOCDATA = 'classes docData;… (OnlyOffice)'
C_LANG = 'attributs lang / xml:lang'
C_OLK = 'attributs data-olk-* (Outlook)'
C_MSODECL = 'déclarations CSS mso-*'
C_LANGDECL = 'déclarations CSS language'
C_FONT = 'déclarations font-family / font'
C_FSIZE = 'déclarations font-size'
C_LH = 'déclarations line-height'
C_MARGIN = 'déclarations de marge / retrait (margin*, text-indent)'
C_BLACK = 'couleur noire (color: black / windowtext / #000…)'
C_BG = 'arrière-plans par défaut (background-*: none/auto/… ou blanc)'
C_NORMAL = 'font-weight / font-style « normal » (sans effet)'
C_WORDPROP = 'autres propriétés Word (tab-stops, text-autospace…)'
C_STYLE_EMPTY = 'attributs style devenus vides'
C_CLASS_EMPTY = 'attributs class devenus vides'
C_SPAN = '<span> sans attribut déroulés'
C_ANCHOR = 'ancres Word (<a name="_Hlk…">) déroulées'
C_EMPTY = '<p>/<span> vides (créés par le nettoyage) supprimés'
C_STRONG = 'font-weight: bold converti en <strong>'
C_EM = 'font-style: italic converti en <em>'
C_BOLD_REDUNDANT = 'font-weight: bold redondant (déjà en gras) retiré'
C_ITAL_REDUNDANT = 'font-style: italic redondant (déjà en italique) retiré'


class Tok(object):
    __slots__ = ('raw', 'out', 'kind', 'name', 'attrs', 'partner')

    def __init__(self, raw, kind, name='', attrs=''):
        self.raw = raw
        self.out = raw
        self.kind = kind          # text | comment | cond | open | close
        self.name = name
        self.attrs = attrs
        self.partner = None


def tokenize(h):
    toks = []
    pos = 0
    for m in TOKEN.finditer(h):
        if m.start() > pos:
            toks.append(Tok(h[pos:m.start()], 'text'))
        raw = m.group(0)
        if raw.startswith('<!--'):
            toks.append(Tok(raw, 'comment'))
        elif raw.startswith('<!['):
            toks.append(Tok(raw, 'cond'))
        else:
            kind = 'close' if m.group(1) else 'open'
            toks.append(Tok(raw, kind, m.group(2).lower(), m.group(3)))
        pos = m.end()
    if pos < len(h):
        toks.append(Tok(h[pos:], 'text'))
    # appariement ouvrante / fermante
    stack = []
    for i, t in enumerate(toks):
        if t.kind == 'open':
            if t.name in VOID or t.attrs.rstrip().endswith('/'):
                continue
            stack.append(i)
        elif t.kind == 'close':
            for k in range(len(stack) - 1, -1, -1):
                if toks[stack[k]].name == t.name:
                    j = stack[k]
                    del stack[k:]
                    toks[j].partner = i
                    t.partner = j
                    break
    return toks


def _is_bold(v):
    v = v.strip().lower()
    return v in ('bold', 'bolder') or (v.isdigit() and int(v) >= 600)


def clean_style(value, ctx, can_wrap, tainted, stats):
    """Retourne (nouvelle valeur, bold_conv, ital_conv, garde) ou None si inchangé."""
    kept = []
    changed = False
    bold = ital = False
    keeps = {'bold': False, 'ital': False, 'fsize': False, 'color': False}
    for d in DECL.findall(value):
        if ':' not in d:
            if d.strip():
                kept.append(d.strip())
            continue
        prop, val = d.split(':', 1)
        prop = prop.strip().lower()
        val_s = val.strip()
        val_l = re.sub(r'\s*!important$', '', val_s.lower())
        cat = None
        if prop.startswith('mso-'):
            cat = C_MSODECL
        elif prop == 'language':
            cat = C_LANGDECL
        elif prop in ('font-family', 'font'):
            cat = C_FONT
        elif prop == 'font-size':
            if tainted or WORD_UNIT.search(val_l):
                cat = C_FSIZE
            elif val_l in ('1rem', '100%', 'medium', 'inherit', '1em') and not ctx['fsize']:
                cat = C_FSIZE
        elif prop == 'line-height':
            if tainted or WORD_UNIT.search(val_l) or val_l == 'normal':
                cat = C_LH
        elif prop in MARGIN_PROPS:
            if tainted or WORD_UNIT.search(val_l):
                cat = C_MARGIN
        elif prop == 'color':
            if BLACK.match(val_l) and not ctx['color']:
                cat = C_BLACK
        elif prop in BG_DEFAULTS:
            if val_l in BG_DEFAULTS[prop]:
                cat = C_BG
        elif prop in ('background', 'background-color'):
            if tainted and WHITE.match(val_l):
                cat = C_BG
        elif prop == 'font-weight':
            if val_l in ('normal', '400'):
                if not ctx['bold']:
                    cat = C_NORMAL
            elif _is_bold(val_l):
                if ctx['bold']:
                    cat = C_BOLD_REDUNDANT
                elif can_wrap:
                    cat = C_STRONG
                    bold = True
        elif prop == 'font-style':
            if val_l == 'normal':
                if not ctx['ital']:
                    cat = C_NORMAL
            elif val_l in ('italic', 'oblique'):
                if ctx['ital']:
                    cat = C_ITAL_REDUNDANT
                elif can_wrap:
                    cat = C_EM
                    ital = True
        elif prop in WORD_PROPS:
            cat = C_WORDPROP
        if cat:
            stats[cat] += 1
            changed = True
            continue
        kept.append(d.strip())
        if prop == 'font-weight' and _is_bold(val_l):
            keeps['bold'] = True
        if prop == 'font-style' and val_l in ('italic', 'oblique'):
            keeps['ital'] = True
        if prop == 'font-size':
            keeps['fsize'] = True
        if prop == 'color':
            keeps['color'] = True
    if not changed:
        return None, False, False, keeps
    new = '; '.join(kept)
    if new and value.rstrip().endswith(';'):
        new += ';'
    return new, bold, ital, keeps


def _attr_value(v):
    if v is None:
        return None, ''
    if v[:1] in ('"', "'"):
        return v[1:-1], v[0]
    return v, ''


def clean_open_tag(tok, ctx, can_wrap, stats):
    """Nettoie les attributs. Retourne (nouvelle balise, n_attributs, bold, ital, keeps)."""
    attrs = list(ATTR.finditer(tok.attrs))
    keeps = {'bold': False, 'ital': False, 'fsize': False, 'color': False}
    consumed = ''.join(m.group(0) for m in attrs)
    tail = tok.attrs[len(consumed):] if tok.attrs.startswith(consumed) else None
    if tail is None or tail.strip() not in ('', '/'):
        return tok.raw, len(attrs), False, False, keeps    # attributs illisibles : intact
    # l'élément vient-il de Word / Office ?
    tainted = False
    for m in attrs:
        n = m.group(1).lower()
        v, _q = _attr_value(m.group(2))
        v = v or ''
        if n == 'class' and re.search(r'(^|\s)(Mso|docData)', v):
            tainted = True
        elif n == 'style' and re.search(r'(^|;)\s*(mso-|font-family\s*:|language\s*:|font\s*:)', v, re.I):
            tainted = True
        elif n.startswith('data-olk'):
            tainted = True
    pieces = []
    n_kept = 0
    changed = False
    bold = ital = False
    for m in attrs:
        n = m.group(1).lower()
        v, q = _attr_value(m.group(2))
        if n in ('lang', 'xml:lang'):
            stats[C_LANG] += 1
            changed = True
            continue
        if n.startswith('data-olk'):
            stats[C_OLK] += 1
            changed = True
            continue
        if n == 'name' and tok.name == 'a' and v and WORD_ANCHOR.match(v):
            stats[C_ANCHOR] += 1
            changed = True
            continue
        if n == 'class' and v is not None:
            classes = v.split()
            out = []
            for c in classes:
                if c.startswith('Mso'):
                    stats[C_MSOCLASS] += 1
                elif c.startswith('docData'):
                    stats[C_DOCDATA] += 1
                else:
                    out.append(c)
            if len(out) != len(classes):
                changed = True
                if not out:
                    stats[C_CLASS_EMPTY] += 1
                    continue
                q = q or '"'
                pieces.append(' class=' + q + ' '.join(out) + q)
                n_kept += 1
                continue
        if n == 'style' and v is not None:
            new, b, i, keeps = clean_style(v, ctx, can_wrap, tainted, stats)
            if new is not None:
                changed = True
                bold, ital = b, i
                if not new.strip():
                    stats[C_STYLE_EMPTY] += 1
                    continue
                q = q or '"'
                pieces.append(' style=' + q + new + q)
                n_kept += 1
                continue
        pieces.append(m.group(0))
        n_kept += 1
    if not changed:
        return tok.raw, n_kept, False, False, keeps
    if n_kept:
        new_raw = '<' + tok.raw[1:1 + len(tok.name)] + ''.join(pieces) + tail + '>'
    else:
        new_raw = '<' + tok.raw[1:1 + len(tok.name)] + tail.strip() + '>'
    return new_raw, n_kept, bold, ital, keeps


def clean_html(h, stats):
    """Nettoie un fragment HTML ; retourne le fragment (identique si rien à faire)."""
    toks = tokenize(h)
    n = len(toks)
    ctx = {'bold': 0, 'ital': 0, 'fsize': 0, 'color': 0}
    pending = {}                    # index de fermante -> décréments de contexte
    skip_until = -1
    for i, t in enumerate(toks):
        if i <= skip_until:
            t.out = ''
            continue
        if t.kind == 'comment':
            t.out = ''
            stats[C_COMMENT] += 1
        elif t.kind == 'cond':
            t.out = ''
            stats[C_COND] += 1
        elif t.kind == 'close':
            if t.name.startswith(OFFICE_NS):
                t.out = ''
            for key in pending.pop(i, ()):
                ctx[key] -= 1
        elif t.kind == 'open':
            if t.name in ('xml', 'style') and t.partner is not None:
                stats[C_BLOCK] += 1
                t.out = ''
                skip_until = t.partner
                continue
            if t.name.startswith(OFFICE_NS):
                t.out = ''
                stats[C_OFFICE] += 1
                continue
            j = t.partner
            inner = toks[i + 1:j] if j is not None else []
            can_wrap = (
                j is not None and t.name in WRAPPABLE
                and not any(x.kind == 'open' and x.name in BLOCK for x in inner)
                and any(x.kind == 'text' and x.raw.strip(ASCII_WS) for x in inner))
            new_raw, n_attrs, bold, ital, keeps = clean_open_tag(t, ctx, can_wrap, stats)
            close_raw = toks[j].raw if j is not None else ''
            unwrap = False
            if j is not None and n_attrs == 0:
                if t.name == 'span':
                    unwrap = True
                    stats[C_SPAN] += 1
                elif t.name == 'a' and new_raw != t.raw:
                    unwrap = True      # ancre Word sans autre attribut
            if unwrap:
                new_raw, close_raw = '', ''
            if bold:
                new_raw, close_raw = new_raw + '<strong>', '</strong>' + close_raw
            if ital:
                new_raw, close_raw = new_raw + '<em>', '</em>' + close_raw
            t.out = new_raw
            if j is not None:
                toks[j].out = close_raw
                decs = []
                if bold or keeps['bold'] or t.name in BOLD_TAGS:
                    decs.append('bold')
                if ital or keeps['ital'] or t.name in ITAL_TAGS:
                    decs.append('ital')
                if keeps['fsize'] or t.name in FSIZE_TAGS:
                    decs.append('fsize')
                if keeps['color']:
                    decs.append('color')
                for key in decs:
                    ctx[key] += 1
                if decs:
                    pending[j] = decs
    # <p>/<span> vidés par le nettoyage (on garde les espaces éventuels)
    for i in range(n - 1, -1, -1):
        t = toks[i]
        if t.kind != 'open' or t.partner is None or t.name not in ('p', 'span'):
            continue
        if not t.out or t.out.endswith('>') is False:
            continue
        j = t.partner
        if t.out.endswith(('<strong>', '<em>')):
            continue
        inner = toks[i + 1:j]
        if not any(x.out != x.raw for x in inner):
            continue
        if any(x.out.strip(ASCII_WS) for x in inner):
            continue
        if not toks[j].out:
            continue
        t.out = ''
        toks[j].out = ''
        stats[C_EMPTY] += 1
    return ''.join(t.out for t in toks)


# --------------------------------------------------------------------------
# Texte brut (pour la vérification)
# --------------------------------------------------------------------------

_RE_COMMENT = re.compile(r'<!--.*?-->', re.S)
_RE_BLOCK = re.compile(r'<(xml|style)\b[^>]*>.*?</\1\s*>', re.S | re.I)
_RE_WS = re.compile(r'[ \t\r\n\f]+')


def plain_text(h):
    """Texte lisible : balises retirées, entités décodées, espaces normalisés."""
    h = _RE_COMMENT.sub('', h)
    h = _RE_BLOCK.sub('', h)
    h = TOKEN.sub('', h)
    return _RE_WS.sub(' ', html.unescape(h)).strip()


INVARIANTS = collections.OrderedDict([
    ('@@PLUGINFILE@@', re.compile(r'@@PLUGINFILE@@/[^"\'<>\s]*')),
    ('Cloze {n:TYPE:…}', re.compile(r'\{\d*:[A-Z_]+:[^}]*\}')),
    ('zones [[n]]', re.compile(r'\[\[[^\]]*\]\]')),
    ('TeX \\( … \\)', re.compile(r'\\\(.*?\\\)', re.S)),
    ('TeX \\[ … \\]', re.compile(r'\\\[.*?\\\]', re.S)),
    ('TeX $$ … $$', re.compile(r'\$\$.*?\$\$', re.S)),
    ('entités', re.compile(r'&(?:#\d+|#x[0-9a-fA-F]+|\w+);')),
    ('balises <img>', re.compile(r'<img\b[^>]*>', re.I)),
    ('liens <a href>', re.compile(r'<a\b[^>]*\bhref\b[^>]*>', re.I)),
])
SEMANTIC_TAGS = ('b', 'strong', 'i', 'em', 'u', 'sub', 'sup', 'ul', 'ol', 'li',
                 'table', 'tr', 'td', 'th', 'a', 'img', 'br', 'p', 'div', 'span',
                 'h1', 'h2', 'h3', 'h4', 'h5', 'h6')
RESIDUALS = collections.OrderedDict([
    ('mso-', re.compile(r'mso-')),
    ('Mso', re.compile(r'Mso')),
    ('docData', re.compile(r'docData')),
    ('<!--', re.compile(r'<!--')),
    ('<o:p', re.compile(r'<o:p')),
    ('lang=', re.compile(r'lang=')),
    ('<w:', re.compile(r'</?w:')),
    ('<m:', re.compile(r'</?m:')),
    ('<xml', re.compile(r'<xml\b')),
    ('<style', re.compile(r'<style\b')),
    ('font-family', re.compile(r'font-family')),
    ('data-olk', re.compile(r'data-olk')),
    ('<span> nu', re.compile(r'<span\s*>')),
    ('style=""', re.compile(r'style\s*=\s*(""|\'\')')),
    ('class=""', re.compile(r'class\s*=\s*(""|\'\')')),
])


_IMG_KEPT = ('src', 'alt', 'width', 'height', 'class', 'role', 'title')


def _img_signature(tag):
    """Attributs d'image qui doivent rester intacts (class : hors classes Mso*)."""
    sig = []
    for m in ATTR.finditer(tag[4:-1]):
        n = m.group(1).lower()
        if n in _IMG_KEPT:
            v = _attr_value(m.group(2))[0] or ''
            if n == 'class':
                v = ' '.join(c for c in v.split() if not c.startswith(('Mso', 'docData')))
                if not v:
                    continue
            sig.append((n, v))
    return tuple(sig)


def invariants_of(h):
    res = []
    for k, rx in INVARIANTS.items():
        found = rx.findall(h)
        if k == 'balises <img>':
            found = [_img_signature(t) for t in found]
        res.append((k, found))
    return res


def tag_counts(h):
    c = collections.Counter()
    for m in TOKEN.finditer(h):
        if m.group(2) and not m.group(1):
            c[m.group(2).lower()] += 1
    return c


# --------------------------------------------------------------------------
# Traitement du fichier Moodle XML
# --------------------------------------------------------------------------

TEXT_FIELD = re.compile(r'<text>(.*?)</text>', re.S)
QUESTION_OPEN = re.compile(r'<question\b([^>]*)>')
PARENT_TAG = re.compile(r'<([A-Za-z_][\w.-]*)[^<>]*>\s*$')
NAME_FIELD = re.compile(r'<name>\s*<text>(.*?)</text>', re.S)
CAT_FIELD = re.compile(r'<category>\s*<text>(.*?)</text>', re.S)


def xml_unescape(s):
    return (s.replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"')
            .replace('&apos;', "'").replace('&amp;', '&'))


def xml_escape(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def decode_field(t):
    """Retourne (html, mode) ; mode = 'cdata' | 'escaped' | None (non traité)."""
    if t.startswith('<![CDATA[') and t.endswith(']]>'):
        inner = t[9:-3]
        if ']]>' in inner or '<![CDATA[' in inner:
            return None, 'multi'
        return inner, 'cdata'
    if '<![CDATA[' in t:
        return None, 'multi'
    if '&lt;' in t:
        return xml_unescape(t), 'escaped'
    return None, None


def encode_field(h, mode):
    if mode == 'cdata':
        return '<![CDATA[' + h + ']]>'
    return xml_escape(h)


def field_text_for_name(t):
    h, mode = decode_field(t)
    if h is None:
        h = xml_unescape(t)
    return plain_text(h) if mode else _RE_WS.sub(' ', h).strip()


def process(src):
    """Retourne (texte de sortie, infos)."""
    stats = collections.Counter()
    info = {
        'stats': stats, 'fields_total': 0, 'fields_html': 0, 'fields_changed': 0,
        'changed': [], 'skipped': [], 'text_mismatch': [], 'invariant_mismatch': [],
        'by_parent': collections.Counter(),
    }
    q_starts, q_types = [], []
    for m in QUESTION_OPEN.finditer(src):
        q_starts.append(m.start())
        tm = re.search(r'type\s*=\s*"([^"]*)"', m.group(1))
        q_types.append(tm.group(1) if tm else '?')
    info['q_starts'], info['q_types'] = q_starts, q_types

    out = []
    pos = 0
    for m in TEXT_FIELD.finditer(src):
        info['fields_total'] += 1
        t = m.group(1)
        h, mode = decode_field(t)
        if mode == 'multi':
            info['skipped'].append((m.start(), 'sections CDATA multiples : champ laissé intact'))
            continue
        if h is None:
            continue
        info['fields_html'] += 1
        local = collections.Counter()
        new = clean_html(h, local)
        if new == h:
            continue
        # garde-fous : texte lisible et éléments protégés strictement identiques
        if plain_text(new) != plain_text(h):
            info['text_mismatch'].append(m.start())
            info['skipped'].append((m.start(), 'texte brut différent après nettoyage : champ laissé intact'))
            continue
        if invariants_of(new) != invariants_of(h):
            info['invariant_mismatch'].append(m.start())
            info['skipped'].append((m.start(), 'élément protégé modifié (image, lien, Cloze, TeX, entité…) : champ laissé intact'))
            continue
        if mode == 'cdata' and ']]>' in new:
            info['skipped'].append((m.start(), ']]> apparu après nettoyage : champ laissé intact'))
            continue
        stats.update(local)
        info['fields_changed'] += 1
        pm = PARENT_TAG.search(src, max(0, m.start() - 300), m.start())
        parent = pm.group(1) if pm else '?'
        info['by_parent'][parent] += 1
        qi = bisect.bisect_right(q_starts, m.start()) - 1
        info['changed'].append({'pos': m.start(), 'q': qi, 'parent': parent,
                                'before': h, 'after': new, 'cats': local})
        out.append(src[pos:m.start(1)])
        out.append(encode_field(new, mode))
        pos = m.end(1)
    out.append(src[pos:])
    return ''.join(out), info


def question_name(src, info, qi):
    if qi < 0:
        return '(hors question)'
    start = info['q_starts'][qi]
    end = src.find('</question>', start)
    seg = src[start:end if end != -1 else start + 20000]
    m = NAME_FIELD.search(seg)
    if m:
        return field_text_for_name(m.group(1))
    m = CAT_FIELD.search(seg)
    if m:
        return '[catégorie] ' + field_text_for_name(m.group(1))
    return '(sans nom)'


# --------------------------------------------------------------------------
# Vérifications
# --------------------------------------------------------------------------

def xml_summary(path):
    """Analyse XML complète : (questions par type, nb <file>, empreinte des <file>)."""
    types = collections.Counter()
    n_files = 0
    digest = hashlib.sha256()
    depth = 0
    for ev, el in ET.iterparse(path, events=('start', 'end')):
        if ev == 'start':
            depth += 1
            continue
        depth -= 1
        if el.tag == 'file':
            n_files += 1
            digest.update(repr(sorted(el.attrib.items())).encode('utf-8'))
            digest.update((el.text or '').encode('utf-8'))
            digest.update(b'\0')
        elif el.tag == 'question':
            types[el.get('type')] += 1
            el.clear()
    return types, n_files, digest.hexdigest()


RAW_FILE = re.compile(r'<file\b[^>]*>[^<]*</file>|<file\b[^>]*/>')


def verify(src, dst, out_path, in_path, info):
    """Retourne une liste de (libellé, ok, détail)."""
    res = []
    # 1. XML bien formé, questions par type, fichiers
    try:
        t_in, f_in, d_in = xml_summary(in_path)
        t_out, f_out, d_out = xml_summary(out_path)
        res.append(('Sortie = XML bien formé', True, 'analyse complète par xml.etree sans erreur'))
        res.append(('Même nombre de <question> par type', t_in == t_out,
                    '%d questions avant, %d après ; %s' % (
                        sum(t_in.values()), sum(t_out.values()),
                        ', '.join('%s=%d' % kv for kv in sorted(t_out.items())))))
        res.append(('Même nombre de <file> et base64 identique (analyse XML)',
                    f_in == f_out and d_in == d_out,
                    '%d avant, %d après ; SHA-256 des contenus %s' % (
                        f_in, f_out, 'identiques' if d_in == d_out else 'DIFFÉRENTS')))
    except ET.ParseError as e:
        res.append(('Sortie = XML bien formé', False, str(e)))
    raw_in = RAW_FILE.findall(src)
    raw_out = RAW_FILE.findall(dst)
    res.append(('Balises <file> identiques octet pour octet (texte brut du fichier)',
                raw_in == raw_out, '%d avant, %d après' % (len(raw_in), len(raw_out))))
    # 2. tout ce qui est hors <text> est identique ; champs non concernés identiques
    f_src = list(TEXT_FIELD.finditer(src))
    f_dst = list(TEXT_FIELD.finditer(dst))
    same_count = len(f_src) == len(f_dst)
    outside_ok = same_count
    identical = modified = 0
    text_diff = []
    if same_count:
        p1 = p2 = 0
        for a, b in zip(f_src, f_dst):
            if src[p1:a.start(1)] != dst[p2:b.start(1)]:
                outside_ok = False
            p1, p2 = a.end(1), b.end(1)
            if a.group(1) == b.group(1):
                identical += 1
            else:
                modified += 1
                ha = decode_field(a.group(1))[0]
                hb = decode_field(b.group(1))[0]
                if ha is None or hb is None or plain_text(ha) != plain_text(hb):
                    text_diff.append(a.start())
        if src[p1:] != dst[p2:]:
            outside_ok = False
    res.append(('Tout ce qui est hors des <text> est identique octet pour octet',
                outside_ok, '%d champs <text> avant, %d après' % (len(f_src), len(f_dst))))
    res.append(('Champs non concernés identiques octet pour octet',
                same_count and modified == info['fields_changed'],
                '%d champs identiques, %d modifiés (attendu : %d)' % (
                    identical, modified, info['fields_changed'])))
    res.append(('Texte brut identique avant/après pour chaque champ modifié',
                not text_diff and same_count,
                '%d champs comparés, %d exception(s)' % (modified, len(text_diff))))
    # 3. éléments protégés
    inv_in = collections.Counter()
    inv_out = collections.Counter()
    inv_ok = True
    for c in info['changed']:
        ia, ib = invariants_of(c['before']), invariants_of(c['after'])
        if ia != ib:
            inv_ok = False
        for k, v in ia:
            inv_in[k] += len(v)
        for k, v in ib:
            inv_out[k] += len(v)
    res.append(('Éléments protégés identiques dans les champs modifiés', inv_ok,
                ' ; '.join('%s : %d → %d' % (k, inv_in[k], inv_out[k]) for k in INVARIANTS)))
    return res


def residual_counts(text):
    joined = '\n'.join(m.group(1) for m in TEXT_FIELD.finditer(text))
    return collections.OrderedDict((k, len(rx.findall(joined))) for k, rx in RESIDUALS.items())


def semantic_counts(info):
    a, b = collections.Counter(), collections.Counter()
    for c in info['changed']:
        a.update(tag_counts(c['before']))
        b.update(tag_counts(c['after']))
    return a, b


# --------------------------------------------------------------------------
# Rapport
# --------------------------------------------------------------------------

def shorten(s, n=320):
    s = s.strip()
    return s if len(s) <= n else s[:n] + ' […]'


def pick_examples(info, k=4):
    wanted = [C_MSODECL, C_MSOCLASS, C_STRONG, C_LANG, C_FONT, C_SPAN, C_DOCDATA]
    chosen, seen = [], set()
    cands = sorted(info['changed'], key=lambda c: len(c['before']))
    for cat in wanted:
        for c in cands:
            if c['pos'] in seen or not c['cats'].get(cat):
                continue
            if 40 <= len(c['before']) <= 600:
                chosen.append(c)
                seen.add(c['pos'])
                break
        if len(chosen) >= k:
            break
    return chosen


def build_report(src, dst, in_path, out_path, info, checks, res_in, res_out):
    w = io.StringIO()
    p = lambda *a: print(*a, file=w)
    q_changed = sorted(set(c['q'] for c in info['changed']))
    types = collections.Counter(info['q_types'])
    p('# Rapport de nettoyage du balisage Word / OnlyOffice (MSO)')
    p()
    p('- Entrée : `%s` (%d octets)' % (in_path, len(src.encode('utf-8'))))
    p('- Sortie : `%s` (%d octets)' % (out_path, len(dst.encode('utf-8'))))
    p('- Éléments `<question>` : %d (%s)' % (
        len(info['q_types']), ', '.join('%s=%d' % kv for kv in sorted(types.items()))))
    p('- Champs `<text>` : %d, dont %d contenant du HTML' % (info['fields_total'], info['fields_html']))
    p('- **Questions modifiées : %d**' % len(q_changed))
    p('- **Champs modifiés : %d** (%s)' % (
        info['fields_changed'], ', '.join('%s=%d' % kv for kv in info['by_parent'].most_common())))
    p()
    p('## Ce qui a été retiré ou transformé')
    p()
    p('| Catégorie | Nombre |')
    p('|---|---:|')
    for k, v in info['stats'].most_common():
        p('| %s | %d |' % (k.replace('|', '\\|'), v))
    p()
    p('## Décomptes résiduels dans les `<text>` (avant → après)')
    p()
    p('| Motif | Avant | Après |')
    p('|---|---:|---:|')
    for k in res_in:
        p('| `%s` | %d | %d |' % (k, res_in[k], res_out[k]))
    p()
    a, b = semantic_counts(info)
    p('## Balises porteuses de sens dans les champs modifiés (avant → après)')
    p()
    p('| Balise | Avant | Après |')
    p('|---|---:|---:|')
    for t in SEMANTIC_TAGS:
        if a[t] or b[t]:
            p('| `<%s>` | %d | %d |' % (t, a[t], b[t]))
    p()
    p('Les écarts attendus : `<span>` (déroulés), `<strong>`/`<em>` (conversions de '
      'styles Word), `<a>` (ancres Word sans lien), `<p>` (paragraphes vidés).')
    p()
    p('## Vérifications')
    p()
    for label, ok, detail in checks:
        p('- [%s] %s — %s' % ('OK' if ok else 'ÉCHEC', label, detail))
    p()
    p('## Non nettoyé / cas laissés tels quels')
    p()
    if info['skipped']:
        for pos, why in info['skipped']:
            qi = bisect.bisect_right(info['q_starts'], pos) - 1
            p('- « %s » : %s' % (question_name(src, info, qi), why))
    else:
        p('- Aucun champ n\'a dû être laissé intact par les garde-fous.')
    left = [(k, v) for k, v in res_out.items() if v]
    if left:
        for k, v in left:
            p('- Il reste %d occurrence(s) de `%s` dans les textes.' % (v, k))
    else:
        p('- Aucun motif résiduel.')
    p()
    p('## Choix conservateurs (laissés tels quels volontairement)')
    p()
    p('- `font-size`, `line-height` et marges en `px`/sans unité sur un élément sans trace '
      'de Word (pas de `mso-*`, `font-family`, classe `Mso*`) : mise en page voulue, conservée.')
    p('- `font-size: 1rem` (sans effet) retiré, sauf dans un titre, un indice/exposant ou un '
      'élément dont la taille est fixée.')
    p('- `font-weight: bold` / `font-style: italic` convertis en `<strong>`/`<em>` seulement '
      'sur `<span>` et `<p>` ; conservés en CSS sur `<div>`, `<td>`, etc.')
    p('- Couleurs autres que le noir pur (y compris les gris très foncés), surlignages, '
      '`text-align`, `text-decoration`, `vertical-align`, bordures, largeurs, attributs '
      '`dir`, `align`, `valign` : conservés.')
    p('- Les tailles de police Word (en `pt`) sont retirées même sur un titre collé de Word : '
      'le texte reste, en gras s\'il l\'était, mais à la taille normale.')
    p()
    p('## Questions touchées (%d)' % len(q_changed))
    p()
    per_q = collections.Counter(c['q'] for c in info['changed'])
    for qi in q_changed:
        typ = info['q_types'][qi] if qi >= 0 else '-'
        p('- %s _(%s, %d champ(s))_' % (question_name(src, info, qi), typ, per_q[qi]))
    p()
    p('## Exemples avant / après')
    for c in pick_examples(info):
        p()
        p('**%s** — champ `%s`' % (question_name(src, info, c['q']), c['parent']))
        p()
        p('Avant :')
        p()
        p('```html')
        p(shorten(c['before']).replace('```', '` ` `'))
        p('```')
        p()
        p('Après :')
        p()
        p('```html')
        p(shorten(c['after']).replace('```', '` ` `'))
        p('```')
    return w.getvalue()


# --------------------------------------------------------------------------
# Autotest (données synthétiques)
# --------------------------------------------------------------------------

def autotest():
    cases = [
        ('<p>Simple &amp; intact \\(a<b\\) {1:MULTICHOICE:=a~b} [[1]]</p>', None),
        ('<p class="MsoNormal" style="margin: 0cm; line-height: 125%;"><span lang="FR-CA" '
         'style="font-size: 11.0pt; font-family: \'Calibri\',sans-serif; mso-ansi-language: FR-CA;">'
         'Texte<o:p></o:p></span></p>', '<p>Texte</p>'),
        ('<!--[if gte mso 9]><xml><w:WordDocument></w:WordDocument></xml><![endif]--><p>A</p>', '<p>A</p>'),
        ('<![if !supportLists]>x<![endif]><p>B</p>', 'x<p>B</p>'),
        ('<style>p {color: red}</style><p>C</p>', '<p>C</p>'),
        ('<p><span style="font-weight: bold; font-family: Aptos; color: black">G</span> n</p>',
         '<p><strong>G</strong> n</p>'),
        ('<p><b><span style="font-weight: bold; mso-bidi-font-weight: normal">G</span></b></p>',
         '<p><b>G</b></p>'),
        ('<p><span style="font-style: italic; color: red; mso-x: y">I</span></p>',
         '<p><span style="color: red"><em>I</em></span></p>'),
        ('<div style="font-size: 18px; font-weight: bold; margin-bottom: 4px">T</div>', None),
        ('<p class="MsoNormal"><span lang="FR"><o:p>&nbsp;</o:p></span></p>', '<p>&nbsp;</p>'),
        ('<p>a</p><p class="MsoNormal"><span lang="FR"><o:p></o:p></span></p><p>b</p>', '<p>a</p><p>b</p>'),
        ('<img src="@@PLUGINFILE@@/a%20b.png" alt="x" width="10" height="5" class="img-fluid MsoNormal" lang="fr">',
         '<img src="@@PLUGINFILE@@/a%20b.png" alt="x" width="10" height="5" class="img-fluid">'),
        ('<p>H<span style="vertical-align: sub; mso-x: y;">2</span>O <span style="background-color: #ffca40">s</span></p>',
         '<p>H<span style="vertical-align: sub;">2</span>O <span style="background-color: #ffca40">s</span></p>'),
        ('<p><a name="_Hlk123"></a><a href="https://example.org" lang="en">l</a></p>',
         '<p><a href="https://example.org">l</a></p>'),
        ('<h3><span style="font-size: 1rem">k</span></h3><p><span style="font-size: 1rem">k</span> <span>z</span></p>',
         '<h3><span style="font-size: 1rem">k</span></h3><p>k z</p>'),
        ('<p>x <span lang="FR"> </span>y \\(a<b \\) <span lang="EN">z</span></p>', '<p>x  y \\(a<b \\) z</p>'),
        ('<p><m:r>x</m:r><w:br/>y</p>', '<p>xy</p>'),
        ('<p class="docData;DOCY;v5;12;AAAA" style="text-align: center; language: fr-CA">d</p>',
         '<p style="text-align: center">d</p>'),
    ]
    bad = 0
    for before, expected in cases:
        if expected is None:
            expected = before
        got = clean_html(before, collections.Counter())
        ok = got == expected and plain_text(got) == plain_text(before)
        if got != clean_html(got, collections.Counter()):
            ok = False       # idempotence
        if not ok:
            bad += 1
            print('ÉCHEC\n  entrée  : %s\n  attendu : %s\n  obtenu  : %s' % (before, expected, got))
    print('autotest : %d cas, %d échec(s)' % (len(cases), bad))
    return 1 if bad else 0


# --------------------------------------------------------------------------

def main(argv):
    if len(argv) == 2 and argv[1] == '--autotest':
        return autotest()
    if len(argv) not in (3, 4):
        print(__doc__)
        return 2
    in_path, out_path = argv[1], argv[2]
    report_path = argv[3] if len(argv) == 4 else None
    if os.path.abspath(in_path) == os.path.abspath(out_path):
        print('Erreur : la sortie doit être différente de l\'entrée.')
        return 2
    with open(in_path, 'r', encoding='utf-8', newline='') as f:
        src = f.read()
    dst, info = process(src)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or '.', exist_ok=True)
    with open(out_path, 'w', encoding='utf-8', newline='') as f:
        f.write(dst)
    checks = verify(src, dst, out_path, in_path, info)
    res_in, res_out = residual_counts(src), residual_counts(dst)
    q_changed = len(set(c['q'] for c in info['changed']))
    print('Questions modifiées : %d ; champs modifiés : %d / %d champs HTML (%d <text>)' % (
        q_changed, info['fields_changed'], info['fields_html'], info['fields_total']))
    print('Taille : %d -> %d caractères' % (len(src), len(dst)))
    for k, v in info['stats'].most_common():
        print('  %5d  %s' % (v, k))
    print('Résiduels (avant -> après) : ' + ', '.join(
        '%s %d->%d' % (k, res_in[k], res_out[k]) for k in res_in))
    all_ok = True
    for label, ok, detail in checks:
        all_ok = all_ok and ok
        print('[%s] %s -- %s' % ('OK' if ok else 'ECHEC', label, detail))
    print('Champs laissés intacts par garde-fou : %d' % len(info['skipped']))
    if report_path:
        os.makedirs(os.path.dirname(os.path.abspath(report_path)) or '.', exist_ok=True)
        with open(report_path, 'w', encoding='utf-8', newline='\n') as f:
            f.write(build_report(src, dst, in_path, out_path, info, checks, res_in, res_out))
        print('Rapport : %s' % report_path)
    return 0 if all_ok else 1


if __name__ == '__main__':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass
    sys.exit(main(sys.argv))
