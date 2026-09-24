#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import html
from html.parser import HTMLParser
import json
import os
import re
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urljoin, urlparse, urlsplit, urlunsplit, quote
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
CONFIG_FILE = ROOT / "source_catalog.json"
DATA_DIR = ROOT / "data"
CATALOG_FILE = DATA_DIR / "catalog.json"
STAGING_FILE = DATA_DIR / "catalog_staging.json"
RAW_DIR = DATA_DIR / "raw"
STATUS_FILE = DATA_DIR / "refresh_status.json"
LOCK_FILE = DATA_DIR / "refresh.lock"


class RefreshAlreadyRunning(RuntimeError):
    pass


def _lock_info():
    try:
        return json.loads(LOCK_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def refresh_lock_active(stale_after_seconds: int = 7200) -> bool:
    if not LOCK_FILE.exists():
        return False
    info = _lock_info()
    started = info.get("started_at")
    try:
        dt = datetime.fromisoformat(str(started).replace("Z", "+00:00"))
        age = (datetime.now(timezone.utc) - dt.astimezone(timezone.utc)).total_seconds()
        if age > stale_after_seconds:
            LOCK_FILE.unlink(missing_ok=True)
            return False
    except Exception:
        try:
            if (datetime.now().timestamp() - LOCK_FILE.stat().st_mtime) > stale_after_seconds:
                LOCK_FILE.unlink(missing_ok=True)
                return False
        except Exception:
            pass
    return LOCK_FILE.exists()


def _acquire_refresh_lock(stale_after_seconds: int = 7200) -> str:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if refresh_lock_active(stale_after_seconds):
        info = _lock_info()
        raise RefreshAlreadyRunning(f"refresh already running (pid={info.get('pid', '?')})")
    token = f"{os.getpid()}-{time.time_ns()}"
    payload = {"token": token, "pid": os.getpid(), "started_at": datetime.now(timezone.utc).isoformat()}
    try:
        fd = os.open(str(LOCK_FILE), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        raise RefreshAlreadyRunning("refresh already running")
    try:
        os.write(fd, json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    finally:
        os.close(fd)
    return token


def _release_refresh_lock(token: str) -> None:
    try:
        info = _lock_info()
        if info.get("token") == token:
            LOCK_FILE.unlink(missing_ok=True)
    except Exception:
        pass

TR_MONTHS = {
    "ocak": 1, "şubat": 2, "subat": 2, "mart": 3, "nisan": 4,
    "mayıs": 5, "mayis": 5, "haziran": 6, "temmuz": 7, "ağustos": 8,
    "agustos": 8, "eylül": 9, "eylul": 9, "ekim": 10, "kasım": 11,
    "kasim": 11, "aralık": 12, "aralik": 12,
}

CATEGORY_KEYWORDS = [
    ("restoran", ["restoran", "restaurant", "cafe", "kafe", "meyhane", "yeme", "içme", "yemek"]),
    ("market", ["market", "gıda", "gida", "süpermarket"]),
    ("giyim", ["giyim", "tekstil", "ayakkabı", "ayakkabi", "aksesuar", "kozmetik", "moda"]),
    ("otel", ["otel", "konaklama"]),
    ("seyahat", ["seyahat", "havayolu", "uçak", "ucak", "tur", "araç kiralama", "arac kiralama", "duty free", "havalimanı", "havalimani"]),
    ("akaryakit", ["akaryakıt", "akaryakit", "otogaz", "benzin", "yakıt", "yakit"]),
    ("sarj", ["elektrikli araç şarj", "elektrikli arac sarj", "şarj istasyonu", "sarj istasyonu"]),
    ("e-ticaret", ["e-ticaret", "eticaret", ".com", "online", "internet", "pazaryeri"]),
    ("saglik", ["sağlık", "saglik", "eczane", "hastane", "medikal"]),
    ("egitim", ["eğitim", "egitim", "okul", "kırtasiye", "kirtasiye", "üniversite", "universite"]),
    ("eglence", ["sinema", "tiyatro", "etkinlik", "müze", "muze", "mobilet", "bilet"]),
    ("sigorta", ["sigorta", "bes", "emeklilik"]),
    ("otopark", ["otopark", "ispark", "park"]),
    ("otomotiv", ["otomotiv", "lastik", "yedek parça", "yedek parca", "servis bakım", "servis bakim"]),
    ("ulasim", ["toplu taşıma", "toplu tasima", "istanbulkart", "ulaşım", "ulasim", "metro", "otobüs", "otobus"]),
    ("dijital", ["dijital platform", "netflix", "spotify", "disney", "twitch", "mubi", "deezer", "xbox", "playstation"]),
    ("elektronik", ["elektronik", "beyaz eşya", "beyaz esya", "televizyon", "bilgisayar"]),
    ("ev", ["mobilya", "yapı market", "yapi market", "dekorasyon", "ısıtma", "isitma", "soğutma", "sogutma"]),
]

@dataclass
class FetchResult:
    url: str
    body: bytes
    content_type: str


class PageParser(HTMLParser):
    BLOCKS = {"p", "li", "div", "section", "article", "main", "br", "h1", "h2", "h3", "h4", "tr", "td", "th"}
    # Script/style/cookie widgets often contain words like "kampanya", percentages and dates.
    # They must never participate in campaign rule extraction.
    SKIP_TAGS = {"script", "style", "noscript", "template", "svg", "canvas"}
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links: list[str] = []
        self.text_parts: list[str] = []
        self.h1_parts: list[str] = []
        self.title_parts: list[str] = []
        self._in_h1 = 0
        self._in_title = 0
        self._heading_tag = None
        self._heading_parts: list[str] = []
        self.headings: list[str] = []
        self.meta_description = ""
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        tag = (tag or "").lower()
        if self._skip_depth:
            self._skip_depth += 1
            return
        if tag in self.SKIP_TAGS:
            self._skip_depth = 1
            return
        attrs = dict(attrs)
        if tag == "a" and attrs.get("href"):
            self.links.append(attrs["href"])
        if tag in self.BLOCKS:
            self.text_parts.append("\n")
        if tag == "h1": self._in_h1 += 1
        if tag in {"h2", "h3", "h4"}:
            self._heading_tag = tag
            self._heading_parts = []
        if tag == "title": self._in_title += 1
        if tag == "meta" and attrs.get("name", "").lower() == "description":
            self.meta_description = attrs.get("content", "")

    def handle_endtag(self, tag):
        tag = (tag or "").lower()
        if self._skip_depth:
            self._skip_depth -= 1
            return
        if tag in self.BLOCKS:
            self.text_parts.append("\n")
        if tag == "h1" and self._in_h1: self._in_h1 -= 1
        if tag in {"h2", "h3", "h4"} and self._heading_tag == tag:
            h = re.sub(r"\s+", " ", "".join(self._heading_parts)).strip()
            if h:
                self.headings.append(h)
            self._heading_tag = None
            self._heading_parts = []
        if tag == "title" and self._in_title: self._in_title -= 1

    def handle_data(self, data):
        if self._skip_depth:
            return
        s = data.strip()
        if not s: return
        self.text_parts.append(s + " ")
        if self._in_h1: self.h1_parts.append(s + " ")
        if self._heading_tag: self._heading_parts.append(s + " ")
        if self._in_title: self.title_parts.append(s + " ")

    @property
    def text(self) -> str:
        raw = "".join(self.text_parts)
        lines = [re.sub(r"\s+", " ", x).strip() for x in raw.splitlines()]
        return "\n".join(x for x in lines if x)

    @property
    def h1(self) -> str:
        return re.sub(r"\s+", " ", "".join(self.h1_parts)).strip()

    @property
    def title(self) -> str:
        return re.sub(r"\s+", " ", "".join(self.title_parts)).strip()


def http_safe_url(url: str) -> str:
    """Percent-encode non-ASCII path/query chars before urllib Request.

    Some official campaign URLs contain ® or curly apostrophes. Passing those
    raw to http.client raises UnicodeEncodeError before any request is sent.
    """
    parts = urlsplit(url)
    path = quote(parts.path or "/", safe="/%:@!$&'()*+,;=-._~")
    query = quote(parts.query or "", safe="=&;%:@!$'()*+,/-._~")
    return urlunsplit((parts.scheme, parts.netloc, path, query, parts.fragment))


def fetch(url: str, timeout: int = 25) -> FetchResult:
    safe_url = http_safe_url(url)
    req = Request(safe_url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142 Safari/537.36 BankaKampanyaAvcisi/1.0",
        "Accept": "text/html,application/xhtml+xml,application/xml,text/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.5",
        "Cache-Control": "no-cache",
    })
    with urlopen(req, timeout=timeout) as r:
        return FetchResult(url=r.geturl(), body=r.read(), content_type=r.headers.get("Content-Type", ""))


def normalize_host(host: str) -> str:
    return (host or "").lower().split(":")[0]


def canonical_url(url: str) -> str:
    p = urlparse(url)
    path = re.sub(r"/+", "/", p.path or "/")
    return f"{p.scheme or 'https'}://{p.netloc}{path}".rstrip("/")


def url_allowed(url: str, source: dict) -> bool:
    p = urlparse(url)
    host = normalize_host(p.netloc)
    domains = {normalize_host(x) for x in source.get("domains", [])}
    if host not in domains:
        return False
    low = url.lower()
    inc = source.get("include_url_substrings", [])
    exc = source.get("exclude_url_substrings", [])
    if inc and not any(s.lower() in low for s in inc): return False
    if any(s.lower() in low for s in exc): return False
    return True


def discover_from_html(url: str, body: bytes, source: dict) -> set[str]:
    parser = PageParser()
    parser.feed(body.decode("utf-8", errors="ignore"))
    out = set()
    for href in parser.links:
        full = canonical_url(urljoin(url, html.unescape(href)))
        if url_allowed(full, source): out.add(full)
    return out


def discover_from_sitemap(body: bytes, source: dict) -> set[str]:
    out: set[str] = set()
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        # tolerate malformed namespaces / text-only XML
        text = body.decode("utf-8", errors="ignore")
        for loc in re.findall(r"<loc>\s*([^<]+)\s*</loc>", text, flags=re.I):
            u = canonical_url(html.unescape(loc.strip()))
            if url_allowed(u, source): out.add(u)
        return out
    for elem in root.iter():
        if elem.tag.lower().endswith("loc") and elem.text:
            u = canonical_url(elem.text.strip())
            if url_allowed(u, source): out.add(u)
    return out



def sitemap_children(body: bytes) -> list[str]:
    out=[]
    try:
        root=ET.fromstring(body)
        if not root.tag.lower().endswith("sitemapindex"): return out
        for elem in root.iter():
            if elem.tag.lower().endswith("loc") and elem.text:
                u=elem.text.strip()
                if u.startswith("http") and u not in out: out.append(u)
    except ET.ParseError:
        text=body.decode("utf-8",errors="ignore")
        if "sitemapindex" in text.lower():
            out=re.findall(r"<loc>\s*(https?://[^<]+)\s*</loc>",text,flags=re.I)
    return out

def discover_from_sitemap_ranked(body: bytes, source: dict) -> list[str]:
    """Sitemap URL'lerini lastmod yeniliğine göre sıralar; aktif/güncel sayfaları öne alır."""
    rows=[]
    try:
        root=ET.fromstring(body)
        for node in root.iter():
            if not node.tag.lower().endswith("url"): continue
            loc=None; lastmod=""
            for ch in list(node):
                tag=ch.tag.lower()
                if tag.endswith("loc"): loc=(ch.text or "").strip()
                elif tag.endswith("lastmod"): lastmod=(ch.text or "").strip()
            if loc:
                u=canonical_url(html.unescape(loc))
                if url_allowed(u,source): rows.append((lastmod,u))
    except ET.ParseError:
        return sorted(discover_from_sitemap(body,source))
    # ISO lastmod strings sort chronologically. Unknown dates stay after dated rows.
    rows.sort(key=lambda x:(bool(x[0]),x[0]),reverse=True)
    out=[]
    for _,u in rows:
        if u not in out: out.append(u)
    return out

def norm_text(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def clean_extracted_text(text: str) -> str:
    """Remove page chrome/cookie/JS fragments without touching campaign legal text."""
    out=[]
    noisy_patterns=[
        r"^//\s*description\s*:", r"kampanyaBoxContainer", r"\.kContBox",
        r"document\.(?:getElementById|querySelector)", r"new Date\(", r"typeof\s+",
        r"localStorage\.", r"sessionStorage\.", r"function\s*\(", r"=>",
        r"üçüncü parti tedarikçilere ait çerez", r"çerezlerle birlikte müşteri deneyimi",
        r"reklamların takibi", r"performans ölçümleri ve hedefleme",
        r"cookie(?:s| policy)?", r"google tag manager",
    ]
    for raw in (text or "").splitlines():
        line=norm_text(raw)
        if not line:
            continue
        low=line.lower()
        if any(re.search(p, low, flags=re.I) for p in noisy_patterns):
            continue
        # Large minified/code-like fragments are never useful legal terms.
        if len(line) > 220 and (line.count("{") + line.count("}") + line.count(";") >= 4):
            continue
        out.append(line)
    return "\n".join(out)


def parse_page(body: bytes) -> dict:
    parser = PageParser()
    parser.feed(body.decode("utf-8", errors="ignore"))
    title = parser.h1 or parser.title or parser.meta_description or "Kampanya"
    title = re.sub(r"\s*[|–-]\s*(Miles.*QNB|Wings|Maximiles.*|Worldcard.*|Türk Ekonomi Bankası.*)$", "", title, flags=re.I).strip()
    # Banka sayfalarında H1'in başına loader metni eklenebiliyor.
    title = re.sub(r"^\s*(?:İşleminiz\s+Devam\s+Ediyor\b[\s.…]*)+", "", title, flags=re.I).strip()
    title = re.sub(r"^\s*(?:Yükleniyor\b[\s.…]*)+", "", title, flags=re.I).strip()
    return {"title": title, "text": clean_extracted_text(parser.text), "links": parser.links, "headings": parser.headings, "metaDescription": norm_text(parser.meta_description)}


def tr_num(s: str | None) -> float | None:
    if s is None: return None
    x = s.strip().replace("₺", "").replace("TL", "").replace(" ", "")
    if not x: return None
    if "." in x and "," in x:
        x = x.replace(".", "").replace(",", ".")
    elif "," in x:
        x = x.replace(".", "").replace(",", ".")
    else:
        # Turkish web content generally uses dot as thousands separator.
        parts = x.split(".")
        if len(parts) > 1 and all(len(p) == 3 for p in parts[1:]): x = "".join(parts)
    try: return float(x)
    except ValueError: return None


def iso_date(y: int, m: int, d: int) -> str | None:
    try: return date(y, m, d).isoformat()
    except ValueError: return None


def parse_date_range(text: str, today: date) -> tuple[str | None, str | None]:
    # 01.09.2026 - 30.09.2026
    m = re.search(r"(\d{1,2})[./](\d{1,2})[./](20\d{2})\s*[-–—]\s*(\d{1,2})[./](\d{1,2})[./](20\d{2})", text)
    if m:
        return iso_date(int(m[3]), int(m[2]), int(m[1])), iso_date(int(m[6]), int(m[5]), int(m[4]))
    # 1-30 Eylül 2026 / 1 – 30 Eylül 2026
    month_re = "|".join(sorted(TR_MONTHS, key=len, reverse=True))
    m = re.search(rf"(\d{{1,2}})\s*[-–—]\s*(\d{{1,2}})\s+({month_re})\s+(20\d{{2}})", text, flags=re.I)
    if m:
        mo = TR_MONTHS[m[3].lower()]
        y = int(m[4]); return iso_date(y, mo, int(m[1])), iso_date(y, mo, int(m[2]))
    # 1 Eylül - 30 Eylül 2026
    m = re.search(rf"(\d{{1,2}})\s+({month_re})\s*[-–—]\s*(\d{{1,2}})\s+({month_re})\s+(20\d{{2}})", text, flags=re.I)
    if m:
        y=int(m[5]); return iso_date(y, TR_MONTHS[m[2].lower()], int(m[1])), iso_date(y, TR_MONTHS[m[4].lower()], int(m[3]))
    # 1 Şubat – 31 Aralık 2026
    m = re.search(rf"(\d{{1,2}})\s+({month_re})\s*[-–—]\s*(\d{{1,2}})\s+({month_re})\s+(20\d{{2}})", text, flags=re.I)
    if m:
        y=int(m[5]); return iso_date(y, TR_MONTHS[m[2].lower()], int(m[1])), iso_date(y, TR_MONTHS[m[4].lower()], int(m[3]))
    # until 30 Eylül 2026 / 30 Eylül 2026'ya kadar. Start unknown.
    m = re.search(rf"(\d{{1,2}})\s+({month_re})\s+(20\d{{2}})[’']?(?:ye|ya)?\s+kadar", text, flags=re.I)
    if m:
        return None, iso_date(int(m[3]), TR_MONTHS[m[2].lower()], int(m[1]))
    # campaign validity text with single start date '1 Ocak 2026 tarihinden itibaren'
    m = re.search(rf"(\d{{1,2}})\s+({month_re})\s+(20\d{{2}})\s+tarihinden itibaren", text, flags=re.I)
    if m:
        return iso_date(int(m[3]), TR_MONTHS[m[2].lower()], int(m[1])), None
    return None, None



def detect_category_info(title: str, text: str, *, meta_description: str = "", category_hint: list[str] | None = None) -> tuple[list[str], str, str]:
    """Conservative sector classifier.

    Priority:
    1) category links from the bank's own official category page,
    2) merchant/sector stated in the campaign title,
    3) meta description / short campaign summary with strong sector phrasing,
    4) otherwise 'diger'.

    Never infer a spend sector from generic page chrome, legal boilerplate or
    "recommended campaigns" text. A wrong category is more harmful than an
    unclassified campaign because the browser would actively show it in the
    wrong sector.
    """
    hint=[str(x).strip() for x in (category_hint or []) if str(x).strip()]
    if hint:
        return list(dict.fromkeys(hint))[:3], "official_category_page", "high"

    title_low = title.lower()
    brand_categories = {
        "migros": "market", "carrefoursa": "market", "happy center": "market", "kim market": "market",
        "macrocenter": "market", "file market": "market",
        "shell": "akaryakit", "opet": "akaryakit", "petrol ofisi": "akaryakit",
        "totalenergies": "akaryakit", "total energies": "akaryakit", "sunpet": "akaryakit",
        "up enerji": "akaryakit",
        "voltrun": "sarj", "zeplin enerji": "sarj", "eşarj": "sarj", "esarj": "sarj", "trugo": "sarj",
        "adidas": "giyim", "network": "giyim", "koton": "giyim", "gratis": "giyim",
        "ikea": "ev", "koçtaş": "ev", "koctas": "ev", "bellamaison": "ev", "bella maison": "ev",
        "mediamarkt": "elektronik", "casper": "elektronik", "dyson": "elektronik",
        "setur": "seyahat", "tatilbudur": "seyahat", "tatilsepeti": "seyahat", "thy": "seyahat", "türk hava yolları": "seyahat", "ajet": "seyahat",
        "kahve dünyası": "restoran", "yemeksepeti": "restoran",
        "apple": "dijital", "microsoft": "dijital", "netflix": "dijital", "spotify": "dijital",
    }
    forced=[]
    for brand, cat in brand_categories.items():
        if brand in title_low and cat not in forced:
            forced.append(cat)
    if forced:
        return forced[:3], "title_brand", "high"

    title_cats=[]
    for cat, keys in CATEGORY_KEYWORDS:
        if any(k in title_low for k in keys):
            title_cats.append(cat)
    if any(x in title_low for x in ["amazon", "trendyol", "hepsiburada", "n11", "pazarama", "gratis.com", "network.com"]):
        if "e-ticaret" not in title_cats:
            title_cats.append("e-ticaret")
    if "sarj" in title_cats:
        title_cats=[x for x in title_cats if x != "akaryakit"]
    if title_cats:
        return list(dict.fromkeys(title_cats))[:3], "title_keywords", "high"

    short = norm_text(meta_description) or norm_text("\n".join((text or "").splitlines()[:8]))
    low = short.lower()
    strong_patterns = [
        ("sarj", [
            r"(?:elektrikli araç|elektrikli arac).{0,40}(?:şarj|sarj)",
            r"(?:şarj|sarj) istasyon(?:u|ları|lari).{0,80}(?:harcama|ödeme|odeme)",
        ]),
        ("akaryakit", [
            r"(?:akaryakıt|akaryakit|otogaz|benzin|yakıt|yakit).{0,80}(?:harcama|alışveriş|alisveris|alım|alim)",
            r"(?:harcama|alışveriş|alisveris|alım|alim).{0,80}(?:akaryakıt|akaryakit|otogaz|benzin|yakıt|yakit)",
        ]),
        ("restoran", [r"(?:restoran|restaurant|kafe|cafe|yeme[- ]?içme|yeme[- ]?icme).{0,80}(?:harcama|ödeme|odeme|alışveriş|alisveris)"]),
        ("market", [r"(?:market|süpermarket|supermarket|gıda|gida).{0,80}(?:harcama|alışveriş|alisveris)"]),
        ("giyim", [r"(?:giyim|tekstil|ayakkabı|ayakkabi|kozmetik).{0,80}(?:harcama|alışveriş|alisveris)"]),
        ("otel", [r"(?:otel|konaklama).{0,80}(?:harcama|ödeme|odeme|rezervasyon)"]),
        ("seyahat", [r"(?:seyahat|uçak|ucak|havayolu|araç kiralama|arac kiralama|duty free).{0,80}(?:harcama|ödeme|odeme|rezervasyon|bilet)"]),
        ("e-ticaret", [r"(?:e-ticaret|eticaret|online|internet).{0,80}(?:harcama|alışveriş|alisveris|ödeme|odeme)"]),
        ("egitim", [r"(?:eğitim|egitim|okul|kırtasiye|kirtasiye).{0,80}(?:harcama|ödeme|odeme|alışveriş|alisveris)"]),
        ("saglik", [r"(?:sağlık|saglik|eczane|hastane|medikal).{0,80}(?:harcama|ödeme|odeme|alışveriş|alisveris)"]),
        ("otomotiv", [r"(?:otomotiv|lastik|yedek parça|yedek parca|servis bakım|servis bakim|oto yıkama|oto yikama).{0,80}(?:harcama|alışveriş|alisveris|ödeme|odeme)"]),
        ("sigorta", [r"(?:sigorta|bes|emeklilik).{0,80}(?:ödeme|odeme|harcama|prim)"]),
        ("otopark", [r"(?:otopark|ispark|park).{0,80}(?:ödeme|odeme|harcama)"]),
        ("eglence", [r"(?:sinema|tiyatro|etkinlik|müze|muze|bilet).{0,80}(?:ödeme|odeme|harcama|alışveriş|alisveris|indirim)"]),
        ("elektronik", [r"(?:elektronik|beyaz eşya|beyaz esya|televizyon|bilgisayar).{0,80}(?:harcama|alışveriş|alisveris|indirim|taksit)"]),
        ("ev", [r"(?:mobilya|yapı market|yapi market|dekorasyon|ev eşyası|ev esyasi).{0,80}(?:harcama|alışveriş|alisveris|indirim|taksit)"]),
        ("dijital", [r"(?:dijital platform|abonelik|netflix|spotify|disney|xbox|playstation).{0,80}(?:harcama|ödeme|odeme|indirim)"]),
    ]
    inferred=[]
    for cat, patterns in strong_patterns:
        if any(re.search(p, low, flags=re.I) for p in patterns):
            inferred.append(cat)
    if "sarj" in inferred:
        inferred=[x for x in inferred if x != "akaryakit"]
    if inferred:
        return list(dict.fromkeys(inferred))[:3], "campaign_summary", "medium"

    return ["diger"], "unclassified", "low"


def detect_categories(title: str, text: str) -> list[str]:
    return detect_category_info(title, text)[0]

def detect_channels(text: str) -> list[str]:
    low = text.lower()
    only_online = bool(re.search(r"yalnızca.*(?:internet|online|mobil uygulama|\.com)|sadece.*(?:internet|online|mobil uygulama|\.com)", low))
    only_physical = bool(re.search(r"yalnızca.*(?:fiziki|mağaza)|sadece.*(?:fiziki|mağaza)", low)) or "online işlemlerde geçerli değildir" in low
    if only_online and not only_physical: return ["online"]
    if only_physical and not only_online: return ["physical"]
    return []


def detect_location(text: str) -> str:
    low = text.lower()
    if "yalnızca yurt dışında" in low or "yurt dışı fiziki" in low or "yurt dışında yapacağınız" in low:
        return "international"
    if "yalnızca yurt iç" in low or "sadece yurt iç" in low:
        return "domestic"
    return "all"


def detect_enrollment(text: str) -> bool:
    low = text.lower()
    if any(p in low for p in ["hemen katıl", "kaydolabilirsiniz", "sms gönder", "katılım zorunlu", "kayıt olabilirsiniz", "kayıt olmanız", "uygulamasından katılın", "üzerinden katılın", "katıl butonuna", "kampanyaya kayıt"]):
        return True
    return bool(re.search(r"kampanyaya[^\n]{0,180}?(?:katıl|kaydol|kayıt ol|kayıt)", low))


def detect_reward_unit(title: str, text: str) -> str:
    hay = (title + " " + text[:1800]).lower()
    if "chip-para" in hay or "chip para" in hay: return "chip_para"
    if "maxipuan" in hay: return "maxipuan"
    if "worldpuan" in hay: return "worldpuan"
    if "mil puan" in hay: return "wings_mil_puan"
    if re.search(r"\bmil\b", hay) and ("miles&smiles" in hay or "qnb" in hay): return "thy_miles"
    if "parapuan" in hay or "para puan" in hay: return "parapuan"
    if "bonus" in hay: return "bonus"
    return "discount_try"


def parse_tiered_fixed(text: str, unit: str) -> dict | None:
    # Generic pairs: 25.000 TL ve üzeri ... 75.000 Mil Puan, 50.000 TL ... 150.000 Mil Puan
    pairs = []
    unit_pat = {
        "thy_miles": r"Mil",
        "wings_mil_puan": r"Mil\s*Puan",
        "maxipuan": r"(?:TL\s+)?MaxiPuan|TL(?:\s+değerinde)?\s+MaxiPuan",
        "worldpuan": r"(?:TL\s+(?:değerinde\s+)?)?Worldpuan",
        "chip_para": r"(?:TL\s+)?chip[- ]?para",
        "parapuan": r"(?:TL\s+(?:değerinde\s+)?)?ParaPuan",
        "bonus": r"(?:TL\s+)?Bonus",
        "discount_try": r"(?:indirim|iade|geri ödeme)",
    }.get(unit)
    if not unit_pat: return None
    pat = rf"([\d\.]+(?:,\d+)?)\s*TL\s*(?:ve\s+üzeri|ve\s+uzeri|[-–]\s*[\d\.]+\s*TL\s+arası)?[^\n,.]{{0,110}}?([\d\.]+(?:,\d+)?)\s*(?:TL\s*)?{unit_pat}"
    for m in re.finditer(pat, text, flags=re.I):
        a = tr_num(m.group(1)); r = tr_num(m.group(2))
        if a and r is not None and a >= 100:
            pairs.append((a, r))
    if unit == "discount_try":
        # 50.000 - 99.999 TL arası ... 3.000 TL, 100.000 TL ve üzeri ... 7.500 TL indirim
        extra=[]
        for m in re.finditer(r"([\d\.]+(?:,\d+)?)\s*(?:TL)?\s*[-–]\s*([\d\.]+(?:,\d+)?)\s*TL\s+arası[^\n]{0,160}?([\d\.]+(?:,\d+)?)\s*TL", text, flags=re.I):
            mn=tr_num(m.group(1)); mx=tr_num(m.group(2)); rw=tr_num(m.group(3))
            if mn and mx and rw is not None: extra.append((mn,mx,rw))
        for m in re.finditer(r"([\d\.]+(?:,\d+)?)\s*TL\s+ve\s+üzeri[^\n]{0,160}?([\d\.]+(?:,\d+)?)\s*TL\s+(?:indirim|iade|geri ödeme)", text, flags=re.I):
            mn=tr_num(m.group(1)); rw=tr_num(m.group(2))
            if mn and rw is not None: extra.append((mn,None,rw))
        if len(extra)>=2:
            extra.sort(key=lambda x:x[0])
            return {"kind":"tiered_fixed","tiers":[{**{"min":mn,"reward":rw},**({"max":mx} if mx is not None else {})} for mn,mx,rw in extra]}

    if len(pairs) >= 2:
        uniq = []
        for x in pairs:
            if x not in uniq: uniq.append(x)
        uniq.sort(key=lambda x: x[0])
        return {"kind": "tiered_fixed", "tiers": [{"min": a, "reward": r} for a, r in uniq]}
    return None


def parse_percent_rule(text: str) -> dict | None:
    # prioritize concrete "X TL+ ... %Y" rather than headline's "up to %Y"
    matches = []
    for m in re.finditer(r"([\d\.]+(?:,\d+)?)\s*TL\s+ve\s+üzeri[^\n,.]{0,120}?%\s*(\d+(?:[,.]\d+)?)", text, flags=re.I):
        mn = tr_num(m.group(1)); rate = tr_num(m.group(2))
        if mn is not None and rate is not None: matches.append((mn, rate/100.0))
    if len(matches) >= 2:
        uniq=[]
        for x in matches:
            if x not in uniq: uniq.append(x)
        uniq.sort(key=lambda x:x[0])
        tiers=[]
        for i,(mn,rate) in enumerate(uniq):
            t={"min":mn,"rate":rate}
            if i+1<len(uniq): t["max"]=uniq[i+1][0]-0.01
            tiers.append(t)
        return {"kind":"tiered_percent","tiers":tiers}
    # amount + percent in either order
    m = re.search(r"(?:tek seferde\s+)?([\d\.]+(?:,\d+)?)\s*TL\s+(?:ve\s+üzeri|üzeri)[^\n]{0,160}?%\s*(\d+(?:[,.]\d+)?)", text, flags=re.I)
    if m:
        return {"kind":"percent","minSpend":tr_num(m.group(1)) or 0,"rate":(tr_num(m.group(2)) or 0)/100.0}
    m = re.search(r"%\s*(\d+(?:[,.]\d+)?)\s+(?:indirim|iade|geri ödeme|para iadesi)", text, flags=re.I)
    if m:
        # search nearby minimum amount
        minm = re.search(r"(?:tek seferde\s+)?([\d\.]+(?:,\d+)?)\s*TL\s+ve\s+üzeri", text, flags=re.I)
        return {"kind":"percent","minSpend":tr_num(minm.group(1)) if minm else 0,"rate":(tr_num(m.group(1)) or 0)/100.0}
    return None


def parse_fixed_rule(title: str, text: str, unit: str) -> dict | None:
    unit_word = {
        "thy_miles":"Mil", "wings_mil_puan":"Mil Puan", "maxipuan":"MaxiPuan", "worldpuan":"Worldpuan",
        "chip_para":"chip-para", "parapuan":"ParaPuan", "bonus":"Bonus"
    }.get(unit)
    if unit_word:
        # 5000 TL+ ... 500 Mil / 7.000 TL ve üzeri ilk alışverişe 500 TL chip-para
        pat = rf"([\d\.]+(?:,\d+)?)\s*TL\s+(?:ve\s+üzeri|üzeri)[^\n]{{0,220}}?([\d\.]+(?:,\d+)?)\s*(?:TL\s*)?{re.escape(unit_word)}"
        m = re.search(pat, text, flags=re.I)
        if m:
            return {"kind":"fixed","minSpend":tr_num(m.group(1)) or 0,"reward":tr_num(m.group(2)) or 0}
        # sometimes "her 5.000 TL ve üzeri ... 500 Mil"
        pat = rf"her\s+([\d\.]+(?:,\d+)?)\s*TL\s+ve\s+üzeri[^\n]{{0,220}}?([\d\.]+(?:,\d+)?)\s*(?:TL\s*)?{re.escape(unit_word)}"
        m = re.search(pat, text, flags=re.I)
        if m:
            return {"kind":"fixed","minSpend":tr_num(m.group(1)) or 0,"reward":tr_num(m.group(2)) or 0}
    # generic TL discount/indirim: 20.000 TL ve üzeri alışverişe 2.000 TL indirim
    m = re.search(r"([\d\.]+(?:,\d+)?)\s*TL\s+ve\s+üzeri[^\n]{0,200}?([\d\.]+(?:,\d+)?)\s*TL\s+(?:indirim|iade|geri ödeme)", text, flags=re.I)
    if m:
        return {"kind":"fixed","minSpend":tr_num(m.group(1)) or 0,"reward":tr_num(m.group(2)) or 0}
    return None


def parse_reward(title: str, text: str) -> tuple[dict, str, bool]:
    unit = detect_reward_unit(title, text)
    tiered = parse_tiered_fixed(text, unit)
    if tiered: return tiered, unit, True
    percent = parse_percent_rule(text)
    if percent:
        # caps
        cap = find_transaction_cap(text)
        if cap is not None: percent["perTransactionCap"] = cap
        return percent, unit if unit != "discount_try" else "discount_try", True
    fixed = parse_fixed_rule(title, text, unit)
    if fixed: return fixed, unit, True
    # Taksit-only or benefit without numeric cash reward: track but do not rank as TL reward.
    if "taksit" in (title + " " + text[:1500]).lower():
        minm = re.search(r"([\d\.]+(?:,\d+)?)\s*TL\s+ve\s+üzeri", text, flags=re.I)
        return {"kind":"non_cash","minSpend":tr_num(minm.group(1)) if minm else 0}, "non_cash", False
    return {"kind":"unknown","minSpend":0}, unit, False


def find_period_cap(text: str, unit: str) -> float | None:
    # "ayda 8.000 TL’ye varan" / "toplamda en fazla 2.500 Mil" / "maksimum 1.000 Mil"
    patterns = [
        r"(?:ayda|aylık(?:\s+bazda)?|aylık\s+ise)\s+(?:toplam\s+)?(?:en fazla\s+)?([\d\.]+(?:,\d+)?)\s*TL",
        r"(?:toplamda\s+)?(?:en fazla|maksimum|azami)\s+([\d\.]+(?:,\d+)?)\s*(?:TL\s*)?(?:Mil\s*Puan|Mil|MaxiPuan|Worldpuan|chip[- ]?para|ParaPuan|Bonus)",
        r"toplamda\s+([\d\.]+(?:,\d+)?)\s*(?:Mil\s*Puan|Mil|MaxiPuan|Worldpuan|chip[- ]?para|ParaPuan|Bonus)['’]?(?:e|a)?\s+varan",
        r"toplam(?:da)?\s+([\d\.]+(?:,\d+)?)\s*(?:TL\s*)?(?:Mil\s*Puan|Mil|MaxiPuan|Worldpuan|chip[- ]?para|ParaPuan|Bonus)\b",
    ]
    vals=[]
    for pat in patterns:
        for m in re.finditer(pat, text, flags=re.I):
            v=tr_num(m.group(1))
            if v is not None: vals.append(v)
    return max(vals) if vals else None


def find_transaction_cap(text: str) -> float | None:
    for pat in [
        r"işlem\s+(?:başına|bazında)\s+(?:en fazla|maksimum)\s+([\d\.]+(?:,\d+)?)\s*TL",
        r"tek\s+bir\s+işlemden\s+(?:en fazla|maksimum)\s+([\d\.]+(?:,\d+)?)\s*TL",
    ]:
        m=re.search(pat,text,flags=re.I)
        if m: return tr_num(m.group(1))
    return None


def reward_starts_from(text: str) -> int | None:
    low=text.lower()
    if re.search(r"ilk .*?sonraki", low) or "ilk alışverişinizden sonraki" in low or "ilk harcamadan sonraki" in low:
        return 2
    m=re.search(r"(ikinci|2\.)\s+ve\s+sonraki",low)
    if m:return 2
    return None


def required_pos(text: str) -> str | None:
    for name in ["Yapı Kredi POS", "QNB POS", "Maximum özellikli POS", "World POS", "TEB POS"]:
        if name.lower() in text.lower(): return name
    return None


def reset_policy(text: str, end_date: str | None) -> str:
    low=text.lower()
    if "her ay" in low or "ayda" in low or "aylık" in low or "takvim ayı" in low: return "monthly"
    return "campaign" if end_date else "monthly"


def detect_merchant_scope(title: str, text: str, categories: list[str], source_key: str, headings: list[str] | None = None) -> dict:
    # Special Crystal merchant list page: use content headings, not every text line.
    # The old implementation accidentally imported the entire Yapı Kredi navigation
    # ("Krediler", "Sigorta", ... ) as merchants, which made real partner matching unreliable.
    if source_key == "crystal_special":
        headings = headings or []
        values=[]
        banned_exact={
            "şubeler", "kampanya detayları", "kampanya koşulları", "kartlar", "kredi kartları",
            "bireysel bankacılık", "özel bankacılık", "krediler", "mevduat ürünleri",
            "yatırım ürünleri", "ödemeler ve hizmetler", "sigorta ve emeklilik", "hesaplama araçları",
            "kobi", "ana sayfa", "işim için", "kendim için", "geri", "sizin için", "firmanız için",
            "teb hakkında", "yurt içi otel ve restoran indirimi"
        }
        banned_terms=[
            " kredi", "kredisi", "hesap", "sigorta", "yatırım", "ödeme", "bankacılık", "başvuru",
            "işlemleri", "paketi", "hizmetleri", "kampanya", "ürünleri", "limit", "pos arıza", "üye işyeri başvurusu"
        ]
        candidate_headings=list(headings)
        # Small/simple pages used by a bank or test fixture may not use H2/H3 tags.
        # Only then fall back to text lines; never do this on a large navigation-heavy page.
        if not candidate_headings and len(text.splitlines()) <= 60:
            candidate_headings=[x for x in text.splitlines() if 2 <= len(norm_text(x)) <= 90]
        for h in candidate_headings:
            ss=norm_text(h).strip(" •-*\t")
            lowh=ss.lower()
            if not (2 <= len(ss) <= 90): continue
            if lowh in banned_exact: continue
            if any(term in lowh for term in banned_terms): continue
            if re.fullmatch(r"(?:istanbul|izmir|ankara|antalya|muğla|mugla|balıkesir|balikesir|bodrum|alaçatı|alacati)", lowh): continue
            # Branch labels are useful aliases but generic section labels are not.
            if ss.endswith(":"): continue
            if ss not in values: values.append(ss)
        values=list(dict.fromkeys(values))[:250]
        return {"kind":"contains" if values else "restricted_unknown", "category":"restoran", "values":values, "requiresBranchConfirmation":True}

    low=(title+" "+text[:1300]).lower()
    title_low=title.lower()
    if "seçili" in title_low and not re.search(r"(?:amazon|trendyol|hepsiburada|n11|pazarama|network|gratis|carrefoursa|king\.com|atü|setur)", title_low):
        return {"kind":"restricted_unknown"}

    candidates=[]
    # Merchant başlık kalıpları. Örn. "Moda Deniz Kulübü Restoranlarında...",
    # "World Cinezone sinema büfelerindeki...", "Amazon'da...".
    merchant_patterns=[
        r"^(.{2,70}?)(?:['’](?:de|da|te|ta))\b",
        r"^(.{2,70}?)\s+(?:mağazalarında|magazalarinda|mağazalarından|sitesinde)\b",
        r"^(.{2,70}?)\s+(?:restoranlarında|restoranlarinda|restaurantlarında|restaurantlarinda)\b",
        r"^(.{2,70}?)\s+(?:sinema\s+büfelerindeki|sinema\s+bufelerindeki|büfelerindeki|bufelerindeki)\b",
        r"^(.{2,70}?)\s+(?:ile)\b",
    ]
    generic_program_names={
        "teb", "qnb", "akbank", "wings", "wings elite", "wings black", "wings black plus",
        "maximiles", "maximiles black", "maximum", "world", "worldcard", "yapı kredi", "yapi kredi",
        "crystal", "miles&smiles qnb", "miles smiles qnb"
    }
    for pat in merchant_patterns:
        m=re.match(pat,title,flags=re.I)
        if m:
            name=m.group(1).strip(" -–—!,:\"")
            name=re.sub(r"^(?:Wings['’]e özel\s+|World Mobil['’]e özel\s+|Maximiles Black['’](?:inize|a)? özel\s+)","",name,flags=re.I).strip()
            if 2 <= len(name) <= 70 and name.lower() not in generic_program_names and name.lower() not in {"kampanya","restoran","market","seyahat","e-ticaret"}:
                candidates.append(name)
                break

    for brand in ["Amazon", "Amazon.com.tr", "Trendyol", "Hepsiburada", "n11", "Pazarama", "Network", "Gratis", "CarrefourSA", "Migros", "ATÜ Duty Free", "Setur", "AJET", "THY", "Mobilet", "İSPARK", "Da Mario", "Günaydın", "Shell", "Opet", "Happy Center", "Kim Market"]:
        # Only trust the campaign title for merchant discovery. Body text often contains
        # recommended campaigns/footer links (e.g. unrelated Hepsiburada/Pazarama names).
        if brand.lower() in title_low and brand not in candidates: candidates.append(brand)
    if candidates:
        cat = categories[0] if len(categories)==1 else None
        return {"kind":"contains","category":cat,"values":candidates}

    # Gerçek sektör kampanyaları merchant bağımsızdır. Decide this only AFTER trying
    # merchant extraction; otherwise "Minoa restoran harcamalarında" became all restaurants.
    title_sector_all = any(p in title_low for p in [
        "tüm restoran", "restoran sektör", "restoran harcam", "restoranlarda %", "otel ve restoran harcam",
        "giyim ve kozmetik sektör", "market harcama", "seyahat harcama", "yurt dışı harcama",
        "e-ticaret harcama", "sigorta ve bes", "sinema ve tiyatro"
    ])
    body_strong_all = any(p in text[:1800].lower() for p in [
        "tüm otel ve restoran harcamalarında", "tüm restoran harcamalarında", "restoran sektöründe yapacağınız"
    ])
    if title_sector_all or body_strong_all:
        return {"kind":"all"}

    # Başlık bir mekan/marka özel kampanyasına benziyor ancak merchant adı güvenle ayrılamadıysa
    # bütün kategoride geçerli kabul etmek tehlikelidir. Bilgi amaçlıya düşür.
    merchantish = bool(re.search(r"(?:restoranlarında|restoranlarinda|mağazalarında|magazalarinda|büfelerindeki|bufelerindeki|\b[A-ZÇĞİÖŞÜ][A-Za-zÇĞİÖŞÜçğıöşü&'.-]+\s+[A-ZÇĞİÖŞÜ][A-Za-zÇĞİÖŞÜçğıöşü&'.-]+)", title))
    benefitish = bool(re.search(r"(?:%\s*\d+|indirim|worldpuan|maxipuan|chip[- ]?para|mil|bonus|fırsat|firsat|taksit)", title, flags=re.I))
    if merchantish and benefitish:
        return {"kind":"restricted_unknown"}
    return {"kind":"all"}


def eligible_for_source(source: dict, title: str, text: str) -> tuple[bool, list[str]]:
    low=(title+"\n"+text).lower()
    key=source["key"]
    reasons=[]
    if key in {"qnb_ms","qnb_private","qnb_card"}:
        if key=="qnb_ms" and "miles&smiles" not in low:
            return False,["Miles&Smiles QNB kart uygunluğu metinde doğrulanamadı"]
        if key=="qnb_card":
            # General QNB pages often explicitly exclude Miles&Smiles. Never recommend those.
            if re.search(r"miles&smiles[^\n]{0,120}(?:hariç|haric|dahil değildir|dahil degildir)", low) or re.search(r"(?:hariçtir|dahil değildir)[^\n]{0,120}miles&smiles", low):
                return False,["Miles&Smiles QNB kampanya dışında"]
        if "private metal" in low and "yalnızca miles&smiles qnb private metal" in low:
            return False,["Yalnızca Private Metal kart için"]
    elif key=="wings":
        # This source is the official Wings domain itself. Do not require every page body
        # to repeat the word "Wings"; Wings Style pages often omit it in visible legal text.
        # Explicit exclusions still win.
        if re.search(r"wings[^\n]{0,120}(?:kampanyaya dahil değildir|hariç|haric)",low):
            return False,["Wings hariç tutulmuş"]
    elif key=="axess_general":
        # Axess sitesindeki genel kampanyalardan yalnızca Wings'in açıkça dahil edildiği sayfaları al.
        if "wings" not in low: return False,["Wings uygunluğu metinde açıkça doğrulanamadı"]
        if re.search(r"wings[^\n]{0,120}(?:dahil değildir|hariç|haric)", low): return False,["Wings kampanya dışında"]
        if not re.search(r"(?:axess[^\n]{0,140})?wings[^\n]{0,160}(?:dahil|faydalanabilir|kart sahipleri)", low):
            # Başlıkta Wings geçmesi tek başına yeterli değil; yasal metinde dahil olduğunu doğrula.
            if "kampanyadan axess, wings" not in low and "axess, wings, free" not in low:
                return False,["Wings'in kampanyaya dahil olduğu yasal metinde doğrulanamadı"]
    elif key=="maximiles":
        if "ticari kampanya" in low and "bireysel" not in low: return False,["Yalnızca ticari kart kampanyası"]
        if re.search(r"maximiles[^\n]{0,100}(?:dahil değildir|hariç|haric)", low): return False,["Maximiles kampanya dışında"]
        # Maximiles sitesi Maximum bireysel kampanyalarını da gösterir; açık hariç tutma yoksa katalogda tutulur.
    elif key in {"world","crystal_special"}:
        if "world eko" in low and "yalnızca" in low and "bireysel kredi kart" not in low: return False,["Crystal uygunluğu doğrulanamadı"]
        if "ticari" in low and "bireysel kredi kart" not in low and key=="world": return False,["Yalnızca ticari kart"]
        if re.search(r"crystal[^\n]{0,100}(?:dahil değildir|hariç|haric)", low): return False,["Crystal kampanya dışında"]
    elif key=="teb":
        # Infinite'e özel kart-dünyası sayfaları veya açıkça tüm bireysel Bonus kartlarını kapsayanlar.
        if "teb infinite" not in low:
            exclusive_other = any(x in low for x in ["she card’a özel", "cepteteb dijital kredi kartı ile", "teb signature kredi kartları’nız ile"]) and "infinite" not in low
            if exclusive_other: return False,["Başka TEB kartına özel"]
            if "bireysel bonus kredi kart" not in low: return False,["TEB Infinite uygunluğu doğrulanamadı"]
    elif key=="teb_general":
        # Genel TEB kampanyalarında yalnızca bireysel kredi kartlarının açıkça dahil edildiği sayfaları al.
        if "banka kart" in title.lower() and "kredi kart" not in title.lower(): return False,["Banka kartı kampanyası"]
        if any(x in low for x in ["ticari kredi kartlarınız ile", "ticari kartlara özel"]) and "bireysel kredi kart" not in low:
            return False,["Yalnızca ticari kart kampanyası"]
        eligible_phrases=["teb bireysel kredi kart", "bireysel teb kredi kart", "bonus özellikli bireysel kredi kart", "sade kart harici bireysel kredi kart", "sade kart hariç tüm bireysel kredi kart"]
        if not any(x in low for x in eligible_phrases): return False,["TEB Infinite/TEB bireysel kredi kartı uygunluğu doğrulanamadı"]
    return True,reasons


def generic_parse(source: dict, url: str, body: bytes, today: date, category_hint: list[str] | None = None) -> dict | None:
    page=parse_page(body); title=page["title"]; text=page["text"]; headings=page.get("headings", [])
    if len(text) < 120: return None
    # Liste/hub sayfalarını kampanya diye içeri alma. Bunlar onlarca farklı kategori ve marka
    # metni taşıdığı için merchant/kategori parserını zehirliyordu (örn. QNB "Kampanyalar").
    generic_title = re.sub(r"\s+", " ", title).strip().lower()
    if generic_title in {"kampanyalar", "tüm kampanyalar", "tum kampanyalar", "kampanya", "kart dünyası", "kart dunyasi", "fırsatlar", "firsatlar"}:
        return None
    if re.fullmatch(r"(?:qnb|wings|worldcard|maximiles|teb)?\s*(?:kampanyalar|kampanya)", generic_title, flags=re.I):
        return None
    ok,reasons=eligible_for_source(source,title,text)
    if not ok: return None
    start,end=parse_date_range(text,today)
    # expired campaigns not needed in active catalog (7-day grace for debugging)
    if end:
        try:
            if date.fromisoformat(end) < today - timedelta(days=7): return None
        except ValueError: pass
    status="active"
    if "kampanya sona ermiştir" in text.lower(): status="expired"
    if end and end < today.isoformat(): status="expired"
    if status=="expired": return None
    cats, category_source, category_confidence = detect_category_info(title, text, meta_description=page.get("metaDescription",""), category_hint=category_hint)
    reward,unit,reward_complete=parse_reward(title,text)
    period_cap=find_period_cap(text,unit)
    tx= {
        "location": detect_location(text),
        "allowedChannels": detect_channels(text),
        "sameDaySameMerchantFirstOnly": bool(re.search(r"aynı gün aynı iş\s*yer[^\n]{0,80}(?:yalnızca|sadece) (?:ilk|bir)",text,flags=re.I)),
        "differentDaysRequired": "farklı günlerde" in text.lower(),
        "differentMerchantsRequired": "farklı iş yerlerinde" in text.lower() or "farklı işyerlerinde" in text.lower(),
        "customerLevel": "müşteri bazında" in text.lower() or "müşteri bazındadır" in text.lower(),
        "nonStackable": "birleştirilemez" in text.lower(),
    }
    rs=reward_starts_from(text)
    if rs: tx["rewardStartsFromQualifyingTransaction"]=rs
    rp=required_pos(text)
    if rp: tx["requiredPos"]=rp
    scope=detect_merchant_scope(title,text,cats,source["key"],headings)
    requires=detect_enrollment(text)
    # Rules are exact enough only for directly computable monetary/miles rewards and date/eligibility.
    complete = reward_complete and reward.get("kind") not in {"unknown","non_cash"}
    # restricted merchant list that wasn't extracted cannot be exact
    if scope.get("kind")=="restricted_unknown": complete=False
    # Aggregate spend campaigns need running spend history; mark condition but keep calculable threshold as conditional.
    aggregate = bool(re.search(r"toplam(?:da)?\s+[\d\.]+(?:,\d+)?\s*TL", text, flags=re.I))
    if aggregate:
        tx["cumulativeSpendCampaign"]=True
        complete=False
    decision_warnings=[]
    if aggregate: decision_warnings.append("Kampanya toplam dönem harcamasına bağlı; mevcut birikmiş harcama kullanıcı tarafından doğrulanmalıdır.")
    if source["key"]=="qnb_private" and "miles&smiles" not in (title+" "+text).lower():
        complete=False
        decision_warnings.append("QNB Private ayrıcalığında Miles&Smiles Private kart uygunluğu metinde açıkça doğrulanamadı; bilgi amaçlı gösteriliyor.")
    # Aynı resmi sayfada farklı müşteri/varlık segmentleri için farklı oranlar varsa genel parserın
    # ilk gördüğü oranı kullanıp yanlış sıralama yapmasına izin verme. Teyit edilmiş sayfalar
    # special_overrides() içinde seçilebilir segment kurallarına göre tekrar kesinleştirilir.
    low_all=(title+" "+text).lower()
    if source["key"]=="wings" and "wings classic" in low_all and "wings black plus" in low_all:
        complete=False
        decision_warnings.append("Kampanya Wings program seviyelerine göre farklı koşullar içeriyor; kullanıcının seviyesine özel kural doğrulanana kadar bilgi amaçlı gösteriliyor.")
    if source["key"]=="maximiles" and "varlık" in low_all:
        asset_markers=sum(1 for marker in ["1.000.000", "4.000.000", "8.000.000"] if marker in low_all)
        if asset_markers >= 2:
            complete=False
            decision_warnings.append("Kampanya Maximiles Black varlık bantlarına göre farklı koşullar içeriyor; seçili varlık bandına özel kural doğrulanana kadar bilgi amaçlı gösteriliyor.")
    if source["key"]=="teb" and "ultra" in low_all and any(x in low_all for x in ["standart paket", "plus paket", "premium paket"]):
        complete=False
        decision_warnings.append("Kampanya TEB paket seviyelerine göre farklı koşullar içeriyor; seçili paket seviyesi doğrulanana kadar bilgi amaçlı gösteriliyor.")
    if source["key"]=="teb_general" and any(x in low_all for x in ["troy logolu", "visa logolu", "mastercard logolu"]):
        complete=False
        decision_warnings.append("Kampanya kart ağı/logosu koşulu içeriyor; TEB Infinite kartının Visa/Mastercard/TROY logosu profilde doğrulanmadığı için bilgi amaçlı gösteriliyor.")
    # Parser tek bir kampanyada ek/alternatif ödül koşullarını güvenle modelleyemiyorsa sıralamaya sokma.
    if re.search(r"(?:ek|ilave)\s+[\d\.]+(?:,\d+)?\s*(?:mil|worldpuan|maxipuan|chip[- ]?para|parapuan|bonus)", text, flags=re.I):
        complete=False
        decision_warnings.append("Kampanyada ek/alternatif ödül kuralı var; otomatik hesap yerine resmi koşul bilgi amaçlı gösteriliyor.")
    if not complete: decision_warnings.append("Kampanya bulundu ancak tüm hesaplama koşulları otomatik olarak kesinleştirilemedi; resmi detay bağlantısını kontrol et.")

    slug=hashlib.sha1(url.encode("utf-8")).hexdigest()[:16]
    return {
        "id": f"live-{source['key']}-{slug}",
        "bank": source["bank"],
        "sourceKey": source["key"],
        "title": title,
        "demo": False,
        "cardProductIds": source["card_products"],
        "categories": cats,
        "categorySource": category_source,
        "categoryConfidence": category_confidence,
        "merchantScope": scope,
        "startDate": start,
        "endDate": end,
        "status": status,
        "resetPolicy": reset_policy(text,end),
        "periodCap": period_cap,
        "requiresEnrollment": requires,
        "rewardRule": reward,
        "rewardUnit": unit,
        "transactionRules": tx,
        "rulesComplete": complete,
        "decisionWarnings": decision_warnings,
        "sourceKind": "official_web_live",
        "sourceUrl": url,
        "verifiedAt": datetime.now(timezone.utc).isoformat(),
        "termsSummary": summarize_terms(text),
        "rawTextDigest": hashlib.sha256(text.encode("utf-8")).hexdigest(),
    }


def known_core_fallback(source: dict, url: str, body: bytes, today: date) -> dict | None:
    """Build a conservative shell for verified persistent benefits when a bank page
    is too script-heavy/short for generic_parse. special_overrides() then supplies
    the verified segment/reward rules. This prevents a core benefit disappearing
    merely because the public page rendering changed.
    """
    low=url.lower()
    markers=(
        "wingscard.com.tr/ayricaliklar/tum-restoranlarda-15e-varan-indirim",
        "maximiles-black-ile-restoranlarda-20-indirim-ayricaligi",
        "teb.com.tr/kart-dunyasi-otel-restoran-indirimi",
        "yapikredi.com.tr/bireysel-bankacilik/kartlar/otel-restoran-indirimleri",
    )
    if not any(m in low for m in markers):
        return None
    page=parse_page(body)
    text=page.get("text") or ""
    title=page.get("title") or "Sürekli Kart Ayrıcalığı"
    start,end=parse_date_range(text,today)
    cats=detect_categories(title,text) or ["restoran"]
    scope=detect_merchant_scope(title,text,cats,source["key"],page.get("headings",[])) if text else {"kind":"restricted_unknown"}
    slug=hashlib.sha1(url.encode("utf-8")).hexdigest()[:16]
    c={
        "id":f"live-{source['key']}-{slug}", "bank":source["bank"], "sourceKey":source["key"],
        "title":title, "demo":False, "cardProductIds":source["card_products"], "categories":cats,
        "merchantScope":scope, "startDate":start, "endDate":end, "status":"active",
        "resetPolicy":"monthly", "periodCap":None, "requiresEnrollment":False,
        "rewardRule":{"kind":"unknown","minSpend":0}, "rewardUnit":"discount_try",
        "transactionRules":{}, "rulesComplete":False,
        "decisionWarnings":["Sayfa genel parser ile çözülemedi; doğrulanmış sürekli ayrıcalık kuralı kullanıldı."],
        "sourceKind":"official_web_live", "sourceUrl":url,
        "verifiedAt":datetime.now(timezone.utc).isoformat(), "termsSummary":summarize_terms(text),
        "rawTextDigest":hashlib.sha256((text or url).encode("utf-8")).hexdigest(),
    }
    return c


def summarize_terms(text: str) -> str:
    lines=[]
    for line in clean_extracted_text(text).splitlines():
        s=norm_text(line)
        if len(s)<25: continue
        low=s.lower()
        if any(x in low for x in ["çerez", "cerez", "cookie", "javascript", "kampanyaboxcontainer", "document."]):
            continue
        if any(k in low for k in ["kampanya", "harcama", "indirim", "puan", " mil", "katıl", "geçerli", "dahil", "taksit", "maksimum", "en fazla", "işlem bazında", "aylık"]):
            lines.append(s)
        if len(" ".join(lines))>650: break
    return " ".join(lines)[:750]


def special_overrides(c: dict) -> dict:
    """Resmi sayfalardan teyit edilmiş yüksek değerli/segment kuralları."""
    url=c.get("sourceUrl","").lower()
    text=(c.get("termsSummary") or "").lower()
    if "teb.com.tr/kart-dunyasi-otel-restoran-indirimi" in url and "yurt-ici" not in url:
        c.update({
            "eligibility":{"segmentLabels":["Standart","Plus","Premium","Ultra"]}, "categories":["restoran","otel"],
            "merchantScope":{"kind":"all"},
            "segmentRules":{
                "Standart":{"rewardRule":{"kind":"percent","rate":0.05,"minSpend":1500,"perTransactionCap":75},"periodCap":250,"rulesComplete":True},
                "Plus":{"rewardRule":{"kind":"percent","rate":0.10,"minSpend":1500,"perTransactionCap":500},"periodCap":2500,"rulesComplete":True},
                "Premium":{"rewardRule":{"kind":"percent","rate":0.15,"minSpend":1500,"perTransactionCap":1000},"periodCap":4000,"rulesComplete":True},
                "Ultra":{"rewardRule":{"kind":"percent","rate":0.20,"minSpend":1500,"perTransactionCap":2000},"periodCap":8000,"rulesComplete":True},
            },
            "rewardRule":{"kind":"percent","rate":0.20,"minSpend":1500,"perTransactionCap":2000},
            "periodCap":8000,"resetPolicy":"monthly","rulesComplete":True,
        })
        c["transactionRules"].update({"sameDaySameMerchantFirstOnly":True})
    elif "teb.com.tr/kart-dunyasi-e-ticaret" in url:
        c.update({"eligibility":{"segmentLabels":["Plus","Premium","Ultra"]},"categories":["e-ticaret"],
                  "segmentRules":{
                      "Plus":{"rewardRule":{"kind":"percent","rate":0.05,"minSpend":1500},"periodCap":200,"rulesComplete":True},
                      "Premium":{"rewardRule":{"kind":"percent","rate":0.05,"minSpend":1500},"periodCap":250,"rulesComplete":True},
                      "Ultra":{"rewardRule":{"kind":"percent","rate":0.05,"minSpend":1500},"periodCap":300,"rulesComplete":True},
                  },
                  "rewardRule":{"kind":"percent","rate":0.05,"minSpend":1500},"periodCap":300,
                  "resetPolicy":"monthly","rulesComplete":True})
        c["transactionRules"].update({"allowedChannels":["online"],"sameDaySameMerchantFirstOnly":True})
    elif "teb.com.tr/kart-dunyasi-sigorta" in url:
        c.update({"eligibility":{"segmentLabels":["Ultra"]},"categories":["sigorta"],
                  "rewardRule":{"kind":"percent","rate":0.05,"minSpend":6000},"periodCap":1500,
                  "resetPolicy":"monthly","rulesComplete":True})
        c["transactionRules"].update({"sameDaySameMerchantFirstOnly":True})
    elif "teb.com.tr/kart-dunyasi-sinema-tiyatro-indirim" in url:
        c.update({"eligibility":{"segmentLabels":["Ultra"]},"categories":["eglence"],
                  "rewardRule":{"kind":"percent","rate":0.05,"minSpend":0},"periodCap":400,
                  "resetPolicy":"monthly","rulesComplete":True})
    elif "teb.com.tr/kart-dunyasi-havalimani-indirim" in url:
        c.update({"eligibility":{"segmentLabels":["Ultra"]},"categories":["otopark"],
                  "rewardRule":{"kind":"percent","rate":0.50,"minSpend":0},"periodCap":600,
                  "resetPolicy":"monthly","rulesComplete":True})
    elif "teb.com.tr/kart-dunyasi-yurt-disi" in url:
        # Minimum/cap yabancı para cinsinden; TL girişinden kur varsayımı yapmıyoruz.
        c.update({"eligibility":{"segmentLabels":["Ultra"]},"categories":["all"],"rulesComplete":False})
        c["transactionRules"].update({"location":"international","allowedChannels":["physical"],"sameDaySameMerchantFirstOnly":True})
        c["decisionWarnings"]=list(dict.fromkeys((c.get("decisionWarnings") or [])+["Alt limit 100 USD/EUR ve dönem tavanı 60 USD; kur çevrimi yapılmadığı için bilgi amaçlı gösteriliyor."]))
    if "wingscard.com.tr/ayricaliklar/tum-restoranlarda-15e-varan-indirim" in url:
        c.update({
            "eligibility":{"segmentLabels":["Classic / 1 milyon TL altı","Black / 1–2 milyon TL","Black Plus / 2 milyon TL+"]},
            "categories":["restoran"],
            "merchantScope":{"kind":"all"},
            "segmentRules":{
                "Classic / 1 milyon TL altı":{"rewardRule":{"kind":"percent","rate":0.05,"minSpend":1000},"periodCap":250,"rulesComplete":True},
                "Black / 1–2 milyon TL":{"rewardRule":{"kind":"percent","rate":0.10,"minSpend":1000},"periodCap":1250,"rulesComplete":True},
                "Black Plus / 2 milyon TL+":{"rewardRule":{"kind":"percent","rate":0.15,"minSpend":1000},"periodCap":2500,"rulesComplete":True},
            },
            "rewardRule":{"kind":"percent","rate":0.15,"minSpend":1000},
            "periodCap":2500,"resetPolicy":"monthly","rulesComplete":True,
            "requiresEnrollment":True,
            "enrollmentMethod":"Akbank Mobil → Kampanyalar → Wings Programları / Program Ayrıcalıkları",
            "startDate":"2026-01-01","endDate":"2026-12-31",
        })
        c["transactionRules"].update({"location":"all"})
    if "maximiles-black-ile-restoranlarda-20-indirim-ayricaligi" in url:
        c.update({
            "eligibility":{"segmentLabels":["1 milyon TL altı","1–4 milyon TL","4–8 milyon TL","8 milyon TL+"]},"categories":["restoran"],
            "merchantScope":{"kind":"all"},
            "segmentRules":{
                "1 milyon TL altı":{"rewardRule":{"kind":"percent","rate":0.05,"minSpend":4000,"perTransactionCap":1000},"periodCap":2000,"rulesComplete":True},
                "1–4 milyon TL":{"rewardRule":{"kind":"tiered_percent","tiers":[{"min":4000,"max":7999.99,"rate":0.10},{"min":8000,"rate":0.20}],"perTransactionCap":1750},"periodCap":4000,"rulesComplete":True},
                "4–8 milyon TL":{"rewardRule":{"kind":"tiered_percent","tiers":[{"min":4000,"max":7999.99,"rate":0.10},{"min":8000,"rate":0.20}],"perTransactionCap":3000},"periodCap":8000,"rulesComplete":True},
                "8 milyon TL+":{"rewardRule":{"kind":"tiered_percent","tiers":[{"min":4000,"max":7999.99,"rate":0.10},{"min":8000,"rate":0.20}],"perTransactionCap":3000},"periodCap":10000,"rulesComplete":True},
            },
            "rewardRule":{"kind":"tiered_percent","tiers":[{"min":4000,"max":7999.99,"rate":0.10},{"min":8000,"rate":0.20}],"perTransactionCap":3000},
            "periodCap":8000,"resetPolicy":"monthly","rulesComplete":True,
        })
    if "maximiles-black-ile-otel-odemelerinize-5-indirim" in url:
        c.update({
            "eligibility":{"segmentLabels":["1 milyon TL altı","1–4 milyon TL","4–8 milyon TL","8 milyon TL+"]},"categories":["otel"],
            "segmentRules":{
                "1 milyon TL altı":{"rewardRule":{"kind":"percent","rate":0.05,"minSpend":25000,"perTransactionCap":1500},"periodCap":1500,"rulesComplete":True},
                "1–4 milyon TL":{"rewardRule":{"kind":"percent","rate":0.05,"minSpend":25000,"perTransactionCap":1500},"periodCap":3000,"rulesComplete":True},
                "4–8 milyon TL":{"rewardRule":{"kind":"percent","rate":0.05,"minSpend":25000,"perTransactionCap":1500},"periodCap":3000,"rulesComplete":True},
                "8 milyon TL+":{"rewardRule":{"kind":"percent","rate":0.05,"minSpend":25000,"perTransactionCap":1500},"periodCap":3000,"rulesComplete":True},
            },
            "rewardRule":{"kind":"percent","rate":0.05,"minSpend":25000,"perTransactionCap":1500},
            "periodCap":3000,"resetPolicy":"monthly","rulesComplete":True,
        })
    if "maximiles-black-le-yapacaginiz-otopark-odemelerinizde-50-indirim" in url or "maximiles-black-ile-yapacaginiz-otopark-odemelerinizde-50-indirim" in url:
        c.update({
            "eligibility":{"segmentLabels":["1 milyon TL altı","1–4 milyon TL","4–8 milyon TL","8 milyon TL+"]},"categories":["otopark"],
            "segmentRules":{
                "1 milyon TL altı":{"rewardRule":{"kind":"percent","rate":0.20,"minSpend":500,"perTransactionCap":500},"periodCap":500,"rulesComplete":True},
                "1–4 milyon TL":{"rewardRule":{"kind":"percent","rate":0.50,"minSpend":500,"perTransactionCap":500},"periodCap":500,"rulesComplete":True},
                "4–8 milyon TL":{"rewardRule":{"kind":"percent","rate":0.50,"minSpend":500,"perTransactionCap":1000},"periodCap":2000,"rulesComplete":True},
                "8 milyon TL+":{"rewardRule":{"kind":"percent","rate":0.50,"minSpend":500,"perTransactionCap":1000},"periodCap":4000,"rulesComplete":True},
            },
            "rewardRule":{"kind":"percent","rate":0.50,"minSpend":500,"perTransactionCap":1000},
            "periodCap":2000,"resetPolicy":"monthly","rulesComplete":True,
        })
    if "otel-restoran-indirimleri" in url and c.get("bank")=="Yapı Kredi":
        c.update({
            "eligibility":{"segmentLabels":["1 milyon TL altı","1–6 milyon TL","6–10 milyon TL","10 milyon TL+","Metal Crystal"]},"categories":["restoran","otel"],
            "segmentRules":{
                "1 milyon TL altı":{"rewardRule":{"kind":"percent","rate":0.20,"minSpend":0,"perTransactionCap":1500},"periodCap":3000,"rulesComplete":True},
                "1–6 milyon TL":{"rewardRule":{"kind":"percent","rate":0.20,"minSpend":0,"perTransactionCap":2500},"periodCap":5000,"rulesComplete":True},
                "6–10 milyon TL":{"rewardRule":{"kind":"percent","rate":0.20,"minSpend":0,"perTransactionCap":3000},"periodCap":7500,"rulesComplete":True},
                "10 milyon TL+":{"rewardRule":{"kind":"percent","rate":0.20,"minSpend":0,"perTransactionCap":4000},"periodCap":10000,"rulesComplete":True},
                "Metal Crystal":{"rewardRule":{"kind":"percent","rate":0.20,"minSpend":0,"perTransactionCap":6000},"periodCap":15000,"rulesComplete":True},
            },
            "rewardRule":{"kind":"percent","rate":0.20,"minSpend":0,"perTransactionCap":1500},
            "periodCap":3000,"resetPolicy":"monthly","rulesComplete":c.get("merchantScope",{}).get("kind")!="restricted_unknown",
        })
        c["transactionRules"].update({"location":"domestic","allowedChannels":["physical"],"requiredPos":"Yapı Kredi POS"})
    if "qnb-terminal-kadikoy-restoran-harcamalarinda" in url:
        merchants=["7DE7","Afitap Meyhane","Arabica Coffee","Cafer Erol","Şekerci Cafer Erol","Deli Deli","Dönerci Cezayir Usta","Espressolab","Etiler Marmaris","Hebun Çorba Evi","Kahve Dünyası Al Götür","Nesta Cuisine","Onur Kebap","Shvili Georgian Bistro","Söğütlü Lokanta","Sütlü D&D","Şef Baklavaları","Trattoria Fontana"]
        c.update({"eligibility":{"segmentLabels":["Private"]},"categories":["restoran"],
                  "merchantScope":{"kind":"contains","category":"restoran","values":merchants,"requiresBranchConfirmation":False},
                  "rewardRule":{"kind":"percent","rate":0.20,"minSpend":0,"perTransactionCap":1000},"periodCap":2000,
                  "resetPolicy":"monthly","rulesComplete":True,"startDate":"2026-07-01","endDate":"2026-12-31"})
        c["requiresEnrollment"]=False
        c["decisionWarnings"]=list(dict.fromkeys((c.get("decisionWarnings") or [])+["Üye işyeri listesi QNB'nin resmi kampanya PDF listesinden eşleştirilir; liste değişirse sonraki sürümde güncellenmelidir."]))
    # QNB Private seçkin beach/restoran sayfası: dönemsel %20, işlem 4.500, dönem 40.000.
    if "seckin-beach-ve-restoranlarda-indirim-ayricaligi" in url:
        merchants=[
            "Miam Restaurant&Bar","Orkide Balık Restaurant","Buddha Bar Beach","La Zucca Pizza Bar","Barbarossa",
            "DAZE Türkbükü","Kahraman Bodrum","Tam Ocakbaşı","Moon Beach","Sarnıç Beach Club","Balıkçı İsmet","Beyaz Beach",
            "Suyah Pool Club","Malva Restaurant","Ezi Restaurant","Garo's Restaurant","Atılay Balık","Beluga Hotel","Ahmet Ustam Ocakbaşı",
            "Memedof","Revma Balık","Minibar-Arnavutköy Balıkçısı","Burhan Restoran","Alaçatı 11 Beach","Dokuzbuçuk Alaçatı",
            "Plaj Dokuzbuçuk","Tarla Alaçatı","Boheme Beach","Sole&Mare Beach Club","Copa Beach","İskele Balık","Kalamar Balık",
            "Qualista Beach","Troy Beach","Palamud Restaurant","Özcan Restaurant"
        ]
        c.update({"eligibility":{"segmentLabels":["Private"]},"categories":["restoran","otel"],
                  "merchantScope":{"kind":"contains","category":"restoran","values":merchants,"requiresBranchConfirmation":False},
                  "rewardRule":{"kind":"percent","rate":0.20,"minSpend":0,"perTransactionCap":4500},"periodCap":40000,
                  "resetPolicy":"campaign","rulesComplete":True,"startDate":"2026-05-01","endDate":"2026-12-31"})
    return c


def load_config() -> list[dict]:
    return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))



def discover_category_hints(source: dict) -> tuple[dict[str, list[str]], list[str]]:
    """Map campaign detail URLs to official sector labels from the bank's category pages."""
    hints: dict[str, list[str]] = {}
    errors: list[str] = []
    for row in source.get("category_listing_urls", []) or []:
        if not isinstance(row, dict):
            continue
        listing=row.get("url")
        categories=[str(x).strip() for x in (row.get("categories") or []) if str(x).strip()]
        if not listing or not categories:
            continue
        try:
            fr=fetch(listing, 12)
            for u in discover_from_html(fr.url, fr.body, source):
                cur=hints.setdefault(canonical_url(u), [])
                for cat in categories:
                    if cat not in cur:
                        cur.append(cat)
        except Exception as e:
            errors.append(f"category-listing {listing}: {type(e).__name__}: {e}")
    return hints, errors

def atomic_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_suffix(path.suffix+".tmp")
    tmp.write_text(json.dumps(obj,ensure_ascii=False,indent=2),encoding="utf-8")
    tmp.replace(path)


def discover_source(source: dict) -> tuple[list[str], list[str]]:
    """Aktif liste sayfalarını önceliklendirir; sitemap yalnızca liste kapsamı yetersizse devreye girer."""
    prioritized=[]; errors=[]
    def add(u):
        u=canonical_url(u)
        if u and u not in prioritized: prioritized.append(u)

    # 1) Kritik/bilinen URL'leri önce ekle. Source detail limiti uygulanırken listenin
    # sonuna düşüp kesilmelerini istemiyoruz. Bu hata Maximiles Black restoran ve TEB
    # sürekli ayrıcalıklarının katalogdan kaybolmasına yol açabiliyordu.
    for u in source.get("fallback_urls",[]): add(u)

    # 2) Canlı liste sayfaları: güncel kampanyaları bunlarla tamamla.
    for listing in source.get("listing_urls",[]):
        try:
            fr=fetch(listing,12)
            for u in sorted(discover_from_html(fr.url,fr.body,source)): add(u)
        except Exception as e:
            errors.append(f"listing {listing}: {type(e).__name__}: {e}")

    # 3) Liste sayfaları yeterince URL vermediyse sitemap ile tamamla.
    # Sitemap arşiv içerdiğinden her zaman taramak gereksiz derecede yavaştı.
    min_candidates=int(source.get("min_listing_candidates", 18) or 18)
    if len(prioritized) < min_candidates:
        for sm in source.get("sitemap_urls",[]):
            try:
                fr=fetch(sm,12)
                children=sitemap_children(fr.body)
                if children:
                    for child in children[:6]:
                        try:
                            cfr=fetch(child,12)
                            for u in discover_from_sitemap_ranked(cfr.body,source): add(u)
                        except Exception as e:
                            errors.append(f"sitemap-child {child}: {type(e).__name__}: {e}")
                else:
                    for u in discover_from_sitemap_ranked(fr.body,source): add(u)
            except Exception as e:
                errors.append(f"sitemap {sm}: {type(e).__name__}: {e}")
    return prioritized,errors

def campaign_identity(c: dict) -> tuple[str, str]:
    bank = norm_text(c.get("bank", "")).lower()
    title = norm_text(c.get("title", "")).lower()
    title = re.sub(r"[^a-z0-9çğıöşü]+", " ", title)
    title = re.sub(r"\s+", " ", title).strip()
    return bank, title


def prefer_campaign(a: dict, b: dict) -> dict:
    """Prefer the duplicate record with more trustworthy/complete structured rules."""
    def score(c):
        return (
            1 if c.get("rulesComplete") else 0,
            1 if c.get("merchantScope", {}).get("kind") not in {"restricted_unknown"} else 0,
            1 if c.get("segmentRules") else 0,
            len(c.get("merchantScope", {}).get("values", []) or []),
            1 if c.get("sourceKey") in {"qnb_card", "maximiles", "teb", "crystal_special", "wings"} else 0,
        )
    return b if score(b) > score(a) else a


def dedupe_campaigns(items: list[dict]) -> list[dict]:
    by_url={}
    for c in items:
        k=c.get("sourceUrl") or c.get("id")
        if k not in by_url: by_url[k]=c
        else: by_url[k]=prefer_campaign(by_url[k],c)
    by_identity={}
    for c in by_url.values():
        ident=campaign_identity(c)
        if not ident[1]:
            by_identity[(ident[0], c.get("sourceUrl") or c.get("id"))]=c
        elif ident not in by_identity:
            by_identity[ident]=c
        else:
            by_identity[ident]=prefer_campaign(by_identity[ident],c)
    return list(by_identity.values())


def _refresh_catalog_impl(max_per_source: int=90) -> dict:
    DATA_DIR.mkdir(parents=True,exist_ok=True); RAW_DIR.mkdir(parents=True,exist_ok=True)
    now=datetime.now(timezone.utc); today=datetime.now().astimezone().date()
    sources=load_config()
    atomic_json(STATUS_FILE,{"state":"running","stage":"starting","last_started_at":now.isoformat(),"campaign_count":0,"error_count":0,"source_index":0,"source_count":len(sources)})
    print("Banka Kampanya Avcisi - canli kampanya taramasi", flush=True)
    print(f"Kaynak sayisi: {len(sources)}", flush=True)

    old={}; old_digest={}
    if CATALOG_FILE.exists():
        try:
            old_data=json.loads(CATALOG_FILE.read_text(encoding="utf-8")); old={c["sourceUrl"]:c for c in old_data.get("campaigns",[]) if c.get("sourceUrl")}
            old_digest={u:c.get("rawTextDigest") for u,c in old.items()}
        except Exception: old={}

    campaigns=[]; source_reports=[]; total_candidates=0; fetched=0
    for src_idx,source in enumerate(sources, start=1):
        key=source["key"]; bank=source["bank"]
        print(f"\n[{src_idx}/{len(sources)}] {bank} / {key}: kampanya linkleri bulunuyor...", flush=True)
        atomic_json(STATUS_FILE,{"state":"running","stage":"discovering","last_started_at":now.isoformat(),"campaign_count":len(campaigns),"error_count":sum(len(r.get('errors',[])) for r in source_reports),"source_index":src_idx,"source_count":len(sources),"current_source":key,"current_bank":bank,"source_done":0,"source_total":0})
        urls,discovery_errors=discover_source(source)
        category_hints,category_hint_errors=discover_category_hints(source)
        discovery_errors.extend(category_hint_errors)
        # Official category pages are also a discovery source. Insert their detail
        # links immediately after hard fallbacks so dynamic "load more" pages cannot
        # hide sector campaigns behind the per-source detail limit.
        priority_n=min(len(source.get("fallback_urls", []) or []), len(urls))
        hinted_missing=[u for u in category_hints.keys() if u not in urls]
        if hinted_missing:
            urls[priority_n:priority_n]=hinted_missing
        source_limit=int(source.get("max_details", max_per_source) or max_per_source)
        ordered=urls[:source_limit]
        total_candidates += len(ordered)
        print(f"  {len(ordered)} aday sayfa bulundu. Detaylar paralel okunuyor...", flush=True)
        errs=list(discovery_errors); kept_items=[]

        def fetch_one(url):
            try:
                fr=fetch(url,12)
                final_url=canonical_url(fr.url)
                hint=category_hints.get(final_url)
                c=generic_parse(source,final_url,fr.body,today,category_hint=hint) if hint else generic_parse(source,final_url,fr.body,today)
                if c is None:
                    c=known_core_fallback(source,final_url,fr.body,today)
                if c: c=special_overrides(c)
                return url,c,None
            except Exception as e:
                return url,None,f"detail {url}: {type(e).__name__}: {e}"

        max_workers=min(12,max(1,len(ordered)))
        done=0
        if ordered:
            with ThreadPoolExecutor(max_workers=max_workers) as ex:
                futures=[ex.submit(fetch_one,u) for u in ordered]
                for fut in as_completed(futures):
                    url,c,err=fut.result(); done += 1; fetched += 1
                    if c is not None:
                        kept_items.append(c)
                    elif err:
                        errs.append(err)
                        if url in old:
                            stale=dict(old[url]); stale["decisionWarnings"]=list(dict.fromkeys((stale.get("decisionWarnings") or [])+["Bu taramada kaynak sayfası okunamadı; son başarılı kayıt gösteriliyor."]))
                            kept_items.append(stale)
                    if done==1 or done%5==0 or done==len(ordered):
                        print(f"  ilerleme {done}/{len(ordered)} · uygun {len(kept_items)} · hata {len(errs)}", flush=True)
                        atomic_json(STATUS_FILE,{"state":"running","stage":"fetching","last_started_at":now.isoformat(),"campaign_count":len(campaigns)+len(kept_items),"error_count":sum(len(r.get('errors',[])) for r in source_reports)+len(errs),"source_index":src_idx,"source_count":len(sources),"current_source":key,"current_bank":bank,"source_done":done,"source_total":len(ordered)})

        if not kept_items:
            stale_count=0
            for stale0 in old.values():
                if stale0.get("sourceKey")==key or str(stale0.get("id","")).startswith(f"live-{key}-"):
                    stale=dict(stale0)
                    stale["decisionWarnings"]=list(dict.fromkeys((stale.get("decisionWarnings") or [])+["Bu kaynak bu taramada kullanılabilir kayıt üretmedi; son başarılı katalog kaydı korunuyor."]))
                    kept_items.append(stale); stale_count += 1
            if stale_count:
                errs.append(f"source {key}: 0 yeni uygun kayıt; son başarılı {stale_count} kayıt korundu")
            else:
                errs.append(f"source {key}: 0 kullanılabilir kayıt ve korunacak önceki kayıt yok")

        campaigns.extend(kept_items)
        source_reports.append({"key":key,"bank":bank,"candidate_count":len(ordered),"kept_count":len(kept_items),"errors":errs[:40]})
        print(f"  tamam: {len(kept_items)} ilgili kampanya katalogda.", flush=True)

        # Tarama sonucu staging dosyasına yazılır. Karar motorunun kullandığı son başarılı
        # tam katalog, tüm kaynaklar bitene kadar asla değiştirilmez.
        partial_items=dedupe_campaigns(campaigns)
        partial_items=sorted(partial_items, key=lambda c:(c.get("bank",""),c.get("endDate") or "9999-99-99",c.get("title","")))
        atomic_json(STAGING_FILE,{"version":1,"generatedAt":datetime.now(timezone.utc).isoformat(),"campaigns":partial_items,"meta":{"candidate_count":total_candidates,"fetched_count":fetched,"campaign_count":len(partial_items),"changed_count":0,"source_reports":source_reports,"partial":True}})

    if not campaigns and old:
        for stale0 in old.values():
            stale=dict(stale0); stale["decisionWarnings"]=list(dict.fromkeys((stale.get("decisionWarnings") or [])+["Canlı tarama başarısız; son başarılı katalog kaydı korunuyor."]))
            campaigns.append(stale)

    campaigns=dedupe_campaigns(campaigns)
    campaigns.sort(key=lambda c:(c.get("bank","") , c.get("endDate") or "9999-99-99", c.get("title","")))
    changed_count=sum(1 for c in campaigns if old_digest.get(c.get("sourceUrl")) != c.get("rawTextDigest")) + sum(1 for u in old if u not in {c.get("sourceUrl") for c in campaigns})
    payload={"version":1,"generatedAt":datetime.now(timezone.utc).isoformat(),"campaigns":campaigns,
             "meta":{"candidate_count":total_candidates,"fetched_count":fetched,"campaign_count":len(campaigns),"changed_count":changed_count,"source_reports":source_reports,"partial":False}}
    atomic_json(CATALOG_FILE,payload)
    try:
        STAGING_FILE.unlink(missing_ok=True)
    except Exception:
        pass
    err_count=sum(len(r["errors"]) for r in source_reports)
    status={"state":"ok" if err_count==0 else "partial_error","stage":"done","last_started_at":now.isoformat(),"last_finished_at":datetime.now(timezone.utc).isoformat(),"source_count":len(source_reports),"campaign_count":len(campaigns),"candidate_count":total_candidates,"fetched_count":fetched,"changed_count":changed_count,"error_count":err_count,"source_reports":source_reports}
    atomic_json(STATUS_FILE,status)
    print("\nTarama bitti.", flush=True)
    print(f"Katalog: {len(campaigns)} kampanya · aday {total_candidates} · okunan {fetched} · hata {err_count}", flush=True)
    return payload

def refresh_catalog(max_per_source: int=90) -> dict:
    """Run one catalog refresh, protected against concurrent processes.

    The server, manual BAT and scheduled task all call this same function.
    A filesystem lock prevents two Python processes from writing catalog.json at once.
    """
    token = _acquire_refresh_lock()
    try:
        return _refresh_catalog_impl(max_per_source)
    finally:
        _release_refresh_lock(token)


def load_catalog() -> dict:
    if CATALOG_FILE.exists():
        try:return json.loads(CATALOG_FILE.read_text(encoding="utf-8"))
        except Exception: pass
    return {"version":1,"generatedAt":None,"campaigns":[],"meta":{"campaign_count":0}}

if __name__=="__main__":
    try:
        result=refresh_catalog()
        print(json.dumps(result["meta"],ensure_ascii=False,indent=2))
    except RefreshAlreadyRunning:
        print("Baska bir kampanya taramasi zaten calisiyor. Ikinci tarama baslatilmadi.", flush=True)
        raise SystemExit(2)
