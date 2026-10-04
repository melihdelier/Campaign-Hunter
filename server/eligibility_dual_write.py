"""v1.5.0 crawler dual-write: add eligibility schema v1 fields NEXT TO the legacy fields.

For every crawled campaign whose legacy eligibility can be translated EXACTLY into stable codes, the crawler
publishes, in addition to the untouched legacy fields (cardProductIds, eligibility.segmentLabels, segmentRules):

    eligibilitySchemaVersion: 1
    eligibilityRule:  payWith cards [+ attr dim in option codes]          (same truth table as the legacy adapter)
    rewardVariants:   one variant per segmentRules entry, `when` = attr   (only when every key maps to a code)

Rules of the translation (legacy parity, tested cross-language by server/tests/test_dual_write.py):
  * Legacy labels map to option codes through the card's `card_segment` dimension `engineLabels`
    (same lookup as web/eligibility.js mapLegacyLabelsToAttr). If ANY card or label cannot be mapped, the
    campaign stays legacy-only (no guess).
  * No implicit reward fallback is created: a segmentRules campaign without segmentLabels (where the legacy
    engine would silently use the base reward for an unknown segment) stays legacy-only.
  * Campaigns that already carry v1 fields (explicit, verified overrides) are left as they are.
  * The produced record must pass the catalog quality guard validator; otherwise the v1 fields are dropped.
Old clients keep reading the legacy fields; new clients prefer valid v1 fields.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

try:
    import eligibility_schema as es
except ImportError:  # pragma: no cover
    from server import eligibility_schema as es

MASTER_FILE = Path(__file__).resolve().parent / "eligibility_master.v1.json"
V1_KEYS = ("eligibilitySchemaVersion", "eligibilityRule", "rewardVariants")


def tr_lower(s) -> str:
    """JS String.prototype.toLocaleLowerCase('tr-TR') for the characters that matter here."""
    return str(s or "").strip().replace("I", "ı").replace("İ", "i").lower()


def load_master(path: Path = MASTER_FILE) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _segment_dims_for_card(master: dict, card: str) -> list[dict]:
    return [d for d in master["dimensions"] if d.get("engineBinding") == "card_segment" and card in (d.get("cardCodes") or [])]


def map_labels(master: dict, card: str, labels: list[str]):
    """Return (dim_code, [option codes]) when ALL labels map inside ONE card_segment dimension of `card`, else None."""
    for d in _segment_dims_for_card(master, card):
        by_label = {tr_lower(lbl): code for code, lbl in (d.get("engineLabels") or {}).items()}
        codes = [by_label.get(tr_lower(l)) for l in labels]
        if codes and all(codes):
            return d["code"], list(dict.fromkeys(codes))
    return None


def _group_parts(groups: list[tuple[list[str], str | None, list[str] | None]]) -> list[dict]:
    parts = []
    for cards, dim, codes in groups:
        pay = {"payWith": {"cards": cards}}
        parts.append(pay if dim is None else {"all": [pay, {"attr": {"dim": dim, "in": codes}}]})
    return parts


def _group_rule(groups: list[tuple[list[str], str | None, list[str] | None]]) -> dict:
    parts = []
    for cards, dim, codes in groups:
        pay = {"payWith": {"cards": cards}}
        parts.append(pay if dim is None else {"all": [pay, {"attr": {"dim": dim, "in": codes}}]})
    return parts[0] if len(parts) == 1 else {"any": parts}


def _members(master: dict, family: str) -> list[str]:
    return next((list(f.get("members") or []) for f in master.get("cardFamilies", []) if f["code"] == family), [])


def translate(campaign: dict, master: dict) -> tuple[dict | None, str]:
    """Return (v1 fields, reason). v1 fields is None when the campaign must stay legacy-only.

    v1.5.0: family/program scope (`cardFamilies`) is written as {payWith:{families:[...]}} — NEVER expanded to the
    currently known member products. Segment labels on a family-scoped campaign are mapped through the family's
    current members only to find the dimension; every member must agree on the same dimension, else legacy-only.
    Explicit exclusions (eligibilityResolution.excludedProducts / excludedFamilies) become a `not` clause."""
    cards = [str(c) for c in (campaign.get("cardProductIds") or [])]
    fams = [str(f) for f in (campaign.get("cardFamilies") or [])]
    if not cards and not fams:
        return None, "no_card_products"
    res = campaign.get("eligibilityResolution") or {}
    exc_cards = [str(c) for c in (res.get("excludedProducts") or [])]
    exc_fams = [str(f) for f in (res.get("excludedFamilies") or [])]
    labels = list((campaign.get("eligibility") or {}).get("segmentLabels") or [])
    seg_rules = campaign.get("segmentRules")
    if isinstance(seg_rules, dict) and seg_rules and not labels:
        return None, "segment_rules_without_labels"  # legacy would use an implicit base fallback; do not reproduce it
    if fams and isinstance(seg_rules, dict) and seg_rules:
        return None, "family_segment_rules"  # reward tiers per family member are not modelled; stay legacy-only

    def family_attr(keys):
        """(dim, codes) shared by every current member of every family, or None."""
        found = None
        for fam in fams:
            members = _members(master, fam)
            if not members:
                return None
            for card in members:
                m = map_labels(master, card, keys)
                if m is None or (found is not None and (m[0], tuple(m[1])) != found):
                    return None
                found = (m[0], tuple(m[1]))
        return found

    parts = []
    if cards:
        if labels:
            mapped = {}
            for card in cards:
                m = map_labels(master, card, labels)
                if m is None:
                    return None, f"unmapped_labels:{card}"
                mapped[card] = m
            groups: dict[tuple, list[str]] = {}
            for card, (dim, codes) in mapped.items():
                groups.setdefault((dim, tuple(codes)), []).append(card)
            parts.extend(_group_parts([(cs, dim, list(codes)) for (dim, codes), cs in groups.items()]))
        else:
            parts.append({"payWith": {"cards": cards}})
    if fams:
        pay = {"payWith": {"families": fams}}
        if labels:
            fa = family_attr(labels)
            if fa is None:
                return None, "unmapped_family_labels"
            parts.append({"all": [pay, {"attr": {"dim": fa[0], "in": list(fa[1])}}]})
        else:
            parts.append(pay)
    rule = parts[0] if len(parts) == 1 else {"any": parts}
    if exc_cards or exc_fams:
        ex = ([{"payWith": {"cards": exc_cards}}] if exc_cards else []) + ([{"payWith": {"families": exc_fams}}] if exc_fams else [])
        rule = {"all": [rule, {"not": ex[0] if len(ex) == 1 else {"any": ex}}]}

    out = {"eligibilitySchemaVersion": 1, "eligibilityRule": rule}

    # rewardVariants (from segmentRules, one per key, same order; no implicit fallback) — product scope only
    if isinstance(seg_rules, dict) and seg_rules:
        variants = []
        for key, entry in seg_rules.items():
            whens = []
            card_groups: dict[tuple, list[str]] = {}
            for card in cards:
                m = map_labels(master, card, [key])
                if m is None:
                    return None, f"unmapped_segment_rule:{key}"
                card_groups.setdefault((m[0], tuple(m[1])), []).append(card)
            for (dim, codes), cs in card_groups.items():
                attr = {"attr": {"dim": dim, "in": list(codes)}}
                whens.append(attr if len(card_groups) == 1 else {"all": [{"payWith": {"cards": cs}}, attr]})
            variant = {"when": whens[0] if len(whens) == 1 else {"any": whens}}
            body = copy.deepcopy(entry) if isinstance(entry, dict) else {}
            if not isinstance(body.get("rewardRule"), dict):
                if not isinstance(campaign.get("rewardRule"), dict):
                    return None, f"segment_rule_without_reward:{key}"
                body["rewardRule"] = copy.deepcopy(campaign["rewardRule"])
            body.pop("eligibility", None)  # segment selection is expressed by `when`
            variant.update(body)
            variants.append(variant)
        out["rewardVariants"] = variants
    return out, "translated"


def add_v1_fields(campaign: dict, master: dict, master_codes: dict | None = None) -> tuple[dict, str]:
    """Return (campaign, status) where status is one of: already_v1 | translated | legacy_only:<reason> | invalid_dropped."""
    if any(k in campaign for k in V1_KEYS):
        return campaign, "already_v1"
    fields, reason = translate(campaign, master)
    if fields is None:
        return campaign, f"legacy_only:{reason}"
    candidate = {**campaign, **fields}
    codes = master_codes if master_codes is not None else es.load_master()
    if es.validate_campaign(candidate, codes)["status"] != "valid":
        return campaign, "invalid_dropped"
    return candidate, "translated"


def dual_write_catalog(campaigns: list[dict], master: dict | None = None) -> tuple[list[dict], dict]:
    master = master if master is not None else load_master()
    codes = es.load_master()
    out, stats = [], {}
    for c in campaigns:
        if c.get("sourceKind") == "user_private":
            out.append(c); continue
        new, status = add_v1_fields(c, master, codes)
        key = status.split(":", 1)[0]
        stats[key] = stats.get(key, 0) + 1
        out.append(new)
    return out, stats
