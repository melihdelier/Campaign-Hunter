"""v1.5.0 — campaign → card eligibility resolution (separate from SOURCE identity).

Crawl first, personalize after: the crawler discovers every campaign of an official source, independent of any user,
of the original six cards and of whether a product is known. WHICH cards a campaign applies to is decided here, per
campaign, from the campaign itself:

  1. official structured data (e.g. the Wings campaign API `card_type` tokens), else
  2. the campaign's own title and terms text,
  3. a per-URL verified override (special_overrides) may replace both.

The source NEVER implies card eligibility (the old `cardProductIds = source["card_products"]` is gone).

Result (`eligibilityResolution` on every crawled record):
    state:          resolved | partial | unresolved | needs_review
    method:         official_api | terms_text | verified_override | none
    bankCode:       bank of the official source (source identity, not eligibility)
    cardProductIds: explicitly named canonical products (only codes that exist in master data)
    cardFamilies:   stable card family/program codes (master data cardFamilies) the campaign targets. The canonical
                    rule stays family-level ({payWith:{families}}); owned products match through master-data membership,
                    so adding a member product needs no campaign change. A family whose membership is incomplete
                    in master data makes the state `partial`, never "resolved to this one product".
    excludedProducts / excludedFamilies: explicit exclusions (become `not` in the rule)
    families:       every card family recognised in the evidence (canonical or not), with relation
    excluded:       families explicitly excluded by the terms
    unmappedTokens: structured tokens that are not in the reviewed vocabulary (kept for review)
    segment:        explicit segment exclusivity (e.g. TEB Ultra-only), if the terms state it
    reasons:        human-readable notes

States:
    resolved      every included family maps to canonical products (cardProductIds non-empty)
    partial       some evidence maps to canonical products, the rest names real card families that are not in master
                  data; OR only non-master families were named (cardProductIds may be empty → applies to no product)
    unresolved    no card-eligibility evidence at all → cardProductIds = []; kept in catalog + diagnostics
    needs_review  conflicting evidence, or only a parent platform (e.g. "Axess", "Maximum Kart") was named, so the
                  inclusion of our products is not stated → cardProductIds = []
Only resolved/partial records with cardProductIds can ever be applicable to a user's card; everything else stays in the
global catalog (Kampanyalar secondary sections + diagnostics) and is never shown as definitely applicable.
Free text never creates canonical products.
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FAMILIES_FILE = ROOT / "card_families.v1.json"
MASTER_FILE = ROOT / "eligibility_master.v1.json"

STATES = ("resolved", "partial", "unresolved", "needs_review")
EVIDENCE_MIN_LINE = 40   # page chrome (nav items, buttons) is shorter; legal sentences are longer
CONJ_GAP = re.compile(r"^[\s,/&]*(?:ve|veya|ile|ya da)?[\s,/&]*(?:(?:kredi\s+)?kart(?:ları|lar|ı)?)?[\s,/&]*$")


def tr_lower(s) -> str:
    return str(s or "").replace("I", "ı").replace("İ", "i").lower()


@lru_cache(maxsize=4)
def _load(path: str = str(FAMILIES_FILE), master_path: str = str(MASTER_FILE)):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    master = json.loads(Path(master_path).read_text(encoding="utf-8"))
    products = {p["code"]: p["bankCode"] for p in master.get("cardProducts", [])}
    # Stable card families/programs (master data). Campaign scope stays at this level; products match via membership.
    card_families = {f["code"]: f for f in master.get("cardFamilies", [])}
    fams = []
    for f in data["families"]:
        # Vocabulary may only point at canonical products / families that exist (never create them from text).
        prods = [p for p in f.get("products", []) if p in products]
        fam = f.get("family")
        if fam and "{bank}" not in fam and fam not in card_families:
            raise ValueError(f"card_families.v1.json: unknown family {fam} (add it to master data first)")
        fams.append({**f, "products": prods, "_re": [re.compile(p) for p in f.get("patterns", [])]})
    segs = [{**s, "_re": [re.compile(p) for p in s.get("patterns", [])]} for s in data.get("segments", [])]
    return {"families": fams, "segments": segs, "exclusion": [tr_lower(w) for w in data.get("exclusionWords", [])],
            "products": products, "cardFamilies": card_families}


def vocabulary():
    return _load()


def bank_products(bank_code: str) -> list[str]:
    return [c for c, b in _load()["products"].items() if b == bank_code]


def family_members(code: str) -> list[str]:
    return list((_load()["cardFamilies"].get(code) or {}).get("members") or [])


def family_complete(code: str) -> bool:
    return (_load()["cardFamilies"].get(code) or {}).get("membershipComplete") is True


def _entry_family(f: dict, bank_code: str | None) -> str | None:
    fam = f.get("family")
    if not fam:
        return None
    if "{bank}" in fam:
        fam = fam.replace("{bank}", bank_code or "")
    return fam if fam in _load()["cardFamilies"] else None


def evidence_lines(title: str, text: str) -> list[str]:
    out = [tr_lower(title)] if title else []
    for line in (text or "").splitlines():
        s = line.strip()
        if len(s) >= EVIDENCE_MIN_LINE:
            out.append(tr_lower(s))
    return out


def _families_for(bank_code: str | None):
    return [f for f in _load()["families"] if f["bank"] in (bank_code, "*")]


def _scan_line(line: str, fams: list[dict], excl_words: list[str]):
    hits = []
    for f in fams:
        for rx in f["_re"]:
            for m in rx.finditer(line):
                hits.append((m.start(), m.end(), f))
    hits.sort(key=lambda h: (h[0], -(h[1] - h[0])))
    # drop hits fully contained in an earlier, longer hit of the SAME family
    pruned = []
    for h in hits:
        if any(p[2] is h[2] and p[0] <= h[0] and h[1] <= p[1] for p in pruned):
            continue
        pruned.append(h)
    hits = pruned
    out = []
    for i, (s, e, f) in enumerate(hits):
        # window: until the next DIFFERENT family mention, unless only a conjunction separates them (coordinated list)
        j = i + 1
        end_window = min(len(line), s + 140)
        while j < len(hits):
            ns = hits[j][0]
            if ns <= e:
                j += 1; continue
            if CONJ_GAP.match(line[e:ns] or ""):
                e = hits[j][1]; j += 1; continue
            end_window = min(end_window, ns)
            break
        window = line[s:end_window]
        dot = re.search(r"\.\s", window)
        if dot:
            window = window[:dot.start()]
        before = line[max(0, s - 25):s]
        after = window[(e - s):] if e - s < len(window) else ""
        # Turkish "hariç" is postpositional ("Sade Kart hariç tüm ...": except Sade Kart) → only text AFTER the match counts
        excluded = any(w in after for w in excl_words)
        exclusive = bool(re.search(r"(?:yalnızca|sadece)\s*$", before)) or bool(re.match(r"[^,.;]{0,40}?['’](?:e|a|ye|ya)\s+özel", line[e:e + 45]))
        out.append({"family": f, "excluded": excluded, "exclusive": exclusive})
    return out


def resolve_from_text(bank_code: str | None, title: str, text: str) -> dict:
    vocab = _load()
    fams = _families_for(bank_code)
    included: dict[str, dict] = {}
    excluded: dict[str, dict] = {}
    exclusive: set[str] = set()
    for line in evidence_lines(title, text):
        for hit in _scan_line(line, fams, vocab["exclusion"]):
            f = hit["family"]
            if f["relation"] == "ignore":
                continue
            (excluded if hit["excluded"] else included)[f["code"]] = f
            if hit["exclusive"] and not hit["excluded"]:
                exclusive.add(f["code"])
    segment = None
    for s in vocab["segments"]:
        if s["bank"] != bank_code:
            continue
        if any(rx.search(line) for line in evidence_lines(title, text) for rx in s["_re"]):
            segment = {"dim": s["dim"], "option": s["option"], "label": s["label"]}
    return _decide(bank_code, included, excluded, exclusive, segment, "terms_text", [])


def resolve_from_tokens(bank_code: str | None, tokens: list[str], title: str = "", text: str = "") -> dict:
    """Official structured card tokens (e.g. Wings API card_type). Text exclusions still win."""
    fams = _families_for(bank_code)
    by_token = {t: f for f in fams for t in f.get("tokens", [])}
    included, unmapped = {}, []
    for raw in tokens:
        t = str(raw or "").strip().lower()
        if not t:
            continue
        f = by_token.get(t)
        if f is None:
            unmapped.append(t)
        elif f["relation"] != "ignore":
            included[f["code"]] = f
    text_res = resolve_from_text(bank_code, title, text) if (title or text) else None
    excluded = {}
    if text_res:
        for code in text_res["excluded"]:
            f = next((x for x in fams if x["code"] == code), None)
            if f:
                excluded[code] = f
    res = _decide(bank_code, included, excluded, set(), text_res["segment"] if text_res else None, "official_api", unmapped)
    if unmapped and res["state"] == "resolved":
        res["state"] = "partial"
        res["reasons"].append("Resmi kart tipi listesinde sözlükte olmayan değer(ler) var: " + ", ".join(unmapped))
    return res


def _decide(bank_code, included: dict, excluded: dict, exclusive: set, segment, method: str, unmapped: list) -> dict:
    """Canonical scope = explicitly named products (cardProductIds) + stable families (cardFamilies). A family is NEVER
    rewritten to its currently known member products; exclusions are kept separately and become `not` in the rule."""
    reasons: list[str] = []
    rel = lambda f: f["relation"]
    explicit = [f for f in included.values() if rel(f) == "product"]
    fam_entries = [f for f in included.values() if rel(f) == "family"]
    others = [f for f in included.values() if rel(f) == "other"]
    platforms = [f for f in included.values() if rel(f) == "platform"]
    products = list(dict.fromkeys(p for f in explicit for p in f["products"]))
    families = list(dict.fromkeys(x for x in (_entry_family(f, bank_code) for f in fam_entries) if x))
    # Exclusivity to a non-master family ("MercedesCard'a özel") overrides BROAD wording ("Maximum özellikli …");
    # an explicitly named product/program (Maximiles, Wings, Miles&Smiles QNB) is kept.
    if any(f["code"] in exclusive for f in others):
        broad = [f for f in fam_entries if f.get("broad")]
        if broad:
            reasons.append("Kampanya ana veride olmayan bir kart ailesine özel; genel ifade bu kartları kapsamıyor.")
            keep = {_entry_family(f, bank_code) for f in fam_entries if not f.get("broad")}
            families = [x for x in families if x in keep]
    excluded_products = sorted({p for f in excluded.values() if rel(f) == "product" for p in f["products"]})
    excluded_families = sorted({x for x in (_entry_family(f, bank_code) for f in excluded.values() if rel(f) == "family") if x})
    hard_conflict = sorted((set(products) & set(excluded_products)) | (set(families) & set(excluded_families)))
    incomplete = [x for x in families if not family_complete(x)]

    evidence = [{"code": f["code"], "relation": rel(f), "products": f["products"], "family": _entry_family(f, bank_code)}
                for f in included.values()]
    if hard_conflict:
        state = "needs_review"
        reasons.append("Koşullar aynı kartı/aileyi hem dahil ediyor hem hariç tutuyor: " + ", ".join(hard_conflict))
        products, families = [], []
    elif products or families:
        state = "partial" if (others or platforms or unmapped or incomplete) else "resolved"
        if incomplete:
            reasons.append("Kampanya aile/program düzeyinde (" + ", ".join(incomplete)
                           + "); ailenin tüm ürünleri ana veride yok — kapsam aile olarak korunur, tek ürüne indirgenmez.")
        if excluded_products or excluded_families:
            reasons.append("Açıkça hariç tutulanlar kuralda ayrıca hariç tutulur: " + ", ".join(excluded_products + excluded_families))
    elif others:
        state = "partial"
        reasons.append("Kampanya ana veride tanımlı olmayan kart aileleri için; tanımlı kartlarına uygulanmaz.")
    elif platforms:
        state = "needs_review"
        reasons.append("Yalnız üst platform adı geçiyor (" + ", ".join(f["code"] for f in platforms)
                       + "); tanımlı kartların dahil olduğu açıkça yazılmıyor.")
    elif excluded and not included:
        state = "partial"
        reasons.append("Koşullar yalnız hariç tutulan kartları adlandırıyor.")
    else:
        state = "unresolved"
        reasons.append("Kampanya koşullarında kart uygunluğu bulunamadı; hiçbir karta kesin uygulanmaz.")
    ok = state in ("resolved", "partial")
    return {
        "state": state, "method": method if (included or excluded or unmapped) else "none",
        "bankCode": bank_code,
        "cardProductIds": products if ok else [],
        "cardFamilies": families if ok else [],
        "excludedProducts": excluded_products if ok else [],
        "excludedFamilies": excluded_families if ok else [],
        "families": evidence, "excluded": sorted(excluded.keys()), "unmappedTokens": list(dict.fromkeys(unmapped)),
        "segment": segment, "reasons": reasons,
    }


# v1.5.0 — per-URL VERIFIED card mapping (official page checked by a person; see docs). This is the only way a card
# product is attached without evidence in the page text/structured data. It is keyed by campaign URL, never by source.
VERIFIED_CARD_OVERRIDES = (
    ("teb.com.tr/kart-dunyasi-otel-restoran-indirimi", ["teb-infinite"]),
    ("teb.com.tr/kart-dunyasi-e-ticaret", ["teb-infinite"]),
    ("teb.com.tr/kart-dunyasi-sigorta", ["teb-infinite"]),
    ("teb.com.tr/kart-dunyasi-sinema-tiyatro-indirim", ["teb-infinite"]),
    ("teb.com.tr/kart-dunyasi-havalimani-indirim", ["teb-infinite"]),
    ("teb.com.tr/kart-dunyasi-yurt-disi", ["teb-infinite"]),
    ("wingscard.com.tr/ayricaliklar/tum-restoranlarda-15e-varan-indirim", ["akbank-wings-elite", "akbank-wings-black"]),
    ("maximiles-black-ile-restoranlarda-20-indirim-ayricaligi", ["is-maximiles-black"]),
    ("maximiles-black-ile-otel-odemelerinize-5-indirim", ["is-maximiles-black"]),
    ("maximiles-black-le-yapacaginiz-otopark-odemelerinizde-50-indirim", ["is-maximiles-black"]),
    ("maximiles-black-ile-yapacaginiz-otopark-odemelerinizde-50-indirim", ["is-maximiles-black"]),
    ("yapikredi.com.tr/bireysel-bankacilik/kartlar/otel-restoran-indirimleri", ["ykb-crystal"]),
    ("crystalcard.com.tr/crystal-dunyasi/yurtici-anlasmali-otel-and-restoran-indirimleri", ["ykb-crystal"]),
    ("qnb-terminal-kadikoy-restoran-harcamalarinda", ["qnb-ms-private"]),
    ("seckin-beach-ve-restoranlarda-indirim-ayricaligi", ["qnb-ms-private"]),
)


def verified_products_for_url(url: str) -> list[str] | None:
    low = (url or "").lower()
    for marker, products in VERIFIED_CARD_OVERRIDES:
        if marker in low:
            return list(products)
    return None


V1_KEYS = ("eligibilitySchemaVersion", "eligibilityRule", "rewardVariants")
STALE_RERESOLVED_NOTE = ("Bu kayıt önceki sürümde kaynağa göre kartlara atanmıştı; kart uygunluğu kaydın kendi metninden yeniden "
                         "çözüldü (metin yetersizse hiçbir karta kesin uygulanmaz).")


def normalize_legacy_record(c: dict, bank_code_by_source: dict | None = None) -> dict:
    """LKG/stale records written before v1.5.0's resolution model carry SOURCE-assumed cardProductIds (and v1 rules
    derived from them). Before such a record is re-published, re-derive eligibility from the record's own text.
    Verified per-URL overrides keep their mapping. User-private records are untouched."""
    if not isinstance(c, dict) or c.get("sourceKind") == "user_private" or isinstance(c.get("eligibilityResolution"), dict):
        return c
    if "cardProductIds" not in c and not any(k in c for k in V1_KEYS):
        return c  # nothing source-assumed to correct
    if any(k in c for k in V1_KEYS):
        try:
            import eligibility_schema as es
        except ImportError:  # pragma: no cover
            from server import eligibility_schema as es
        if es.validate_campaign(c, es.load_master())["status"] == "invalid":
            return c  # fail closed: the quality guard drops it; never "sanitise" an invalid record into a legacy one
    out = dict(c)
    bank_code = out.get("bankCode") or (bank_code_by_source or {}).get(out.get("sourceKey"))
    verified = verified_products_for_url(out.get("sourceUrl"))
    if verified is not None:
        res = verified_override(bank_code, verified, "Resmi sayfa kişi tarafından doğrulandı (URL bazlı doğrulanmış eşleme).")
    else:
        res = resolve_from_text(bank_code, out.get("title") or "", out.get("termsSummary") or "")
        for k in V1_KEYS:  # v1 rules were derived from the source assumption; dual-write re-derives them
            out.pop(k, None)
        out["decisionWarnings"] = list(dict.fromkeys((out.get("decisionWarnings") or []) + [STALE_RERESOLVED_NOTE]))
    out["bankCode"] = bank_code
    return apply_resolution(out, res)


def verified_override(bank_code: str | None, products: list[str], note: str) -> dict:
    known = _load()["products"]
    prods = [p for p in products if p in known]
    return {"state": "resolved" if prods else "unresolved", "method": "verified_override", "bankCode": bank_code,
            "cardProductIds": prods, "cardFamilies": [], "excludedProducts": [], "excludedFamilies": [],
            "families": [], "excluded": [], "unmappedTokens": [], "segment": None, "reasons": [note]}


def is_applicable_state(res: dict | None) -> bool:
    return bool(res) and res.get("state") in ("resolved", "partial") and bool(res.get("cardProductIds") or res.get("cardFamilies"))


def apply_resolution(c: dict, res: dict) -> dict:
    """Write a resolution onto a campaign record: canonical scope fields are explicit products + families."""
    c["cardProductIds"] = list(res.get("cardProductIds") or [])
    c["cardFamilies"] = list(res.get("cardFamilies") or [])
    c["eligibilityResolution"] = res
    return c
