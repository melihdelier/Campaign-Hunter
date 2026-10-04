"""Eligibility schema v1 validator for the catalog quality guard (Python port of web/eligibility.js).

The rules are identical to `validateCampaignEligibility` / `checkEligibilityRule` in web/eligibility.js.
Both implementations are run against the same fixture (docs/eligibility-validation-cases.v1.json), so
they cannot drift apart silently.

A campaign "uses the new schema" when it has an `eligibilityRule` or `rewardVariants` KEY (even if the
value is null). It must then carry `eligibilitySchemaVersion` == the integer 1. A missing, malformed or
unsupported version, or a malformed rule, makes the campaign INVALID. An invalid campaign is never
published and never re-interpreted through the legacy fields (cardProductIds / segmentLabels).

Master-data checks (server/eligibility_master.v1.json):
  - unknown dimension / option code      -> error   (the rule could never be satisfied; almost surely a typo)
  - unknown card product / bank code     -> warning (product not yet in master data, e.g. qnb-fix; inert)
  - unknown card family code             -> warning (inert: no product is a member)
v1.5.0: payWith/owns accept `families` (stable card family/program codes); products match through master-data
membership, so the rule stays family-level when new member products are added.

Only the Python standard library is used.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

SUPPORTED_VERSIONS = (1,)
NODE_KEYS = ("all", "any", "not", "payWith", "owns", "attr", "always", "legacySegmentLabel")
CODE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
MAX_DEPTH = 12
MASTER_FILE = Path(__file__).resolve().parent / "eligibility_master.v1.json"


def load_master(path: Path = MASTER_FILE) -> dict:
    m = json.loads(Path(path).read_text(encoding="utf-8"))
    return {
        "banks": set(m["banks"]),
        "cards": {p["code"] for p in m["cardProducts"]},
        "families": {f["code"] for f in m.get("cardFamilies", [])},
        "dims": {d["code"]: set(d["options"]) for d in m["dimensions"]},
    }


def _is_code(v) -> bool:
    return isinstance(v, str) and bool(CODE.match(v))


def _is_int(v) -> bool:
    # bool is a subclass of int in Python; JSON true must not count as version 1. Floats like 1.0 are rejected
    # as well (JS sees 1.0 and 1 identically, but the crawler always writes an integer).
    return isinstance(v, int) and not isinstance(v, bool)


def check_rule(rule, master: dict | None = None, path: str = "$", strict: bool = False) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    def walk(node, p: str, depth: int) -> None:
        if depth > MAX_DEPTH:
            errors.append(f"{p}: too deep"); return
        if not isinstance(node, dict):
            errors.append(f"{p}: node must be an object"); return
        if len(node) != 1 or next(iter(node)) not in NODE_KEYS:
            errors.append(f"{p}: exactly one of {', '.join(NODE_KEYS)}"); return
        op, arg = next(iter(node.items()))
        if op in ("all", "any"):
            if not isinstance(arg, list) or not arg:
                errors.append(f"{p}.{op}: non-empty array required")
            else:
                for i, r in enumerate(arg):
                    walk(r, f"{p}.{op}[{i}]", depth + 1)
        elif op == "not":
            walk(arg, f"{p}.not", depth + 1)
        elif op == "always":
            if arg is not True:
                errors.append(f"{p}.always: must be true")
        elif op in ("payWith", "owns"):
            if not isinstance(arg, dict) or ("cards" not in arg and "banks" not in arg and "families" not in arg):
                errors.append(f"{p}.{op}: cards, banks and/or families required"); return
            extra = [k for k in arg if k not in ("cards", "banks", "families")]
            if extra:
                errors.append(f"{p}.{op}: unknown key(s) {', '.join(extra)}")
            for k in ("cards", "banks", "families"):
                if k not in arg:
                    continue
                vals = arg[k]
                if not isinstance(vals, list) or not vals or not all(_is_code(v) for v in vals):
                    errors.append(f"{p}.{op}.{k}: non-empty array of codes"); continue
                if master is not None:
                    known = {"cards": master["cards"], "banks": master["banks"], "families": master.get("families", set())}[k]
                    label = {"cards": "card product", "banks": "bank", "families": "card family"}[k]
                    for v in vals:
                        if v not in known:
                            warnings.append(f"{p}.{op}.{k}: unknown {label} {v}")
        elif op == "attr":
            ok = (isinstance(arg, dict) and set(arg) <= {"dim", "in"} and _is_code(arg.get("dim"))
                  and isinstance(arg.get("in"), list) and arg["in"] and all(_is_code(v) for v in arg["in"]))
            if not ok:
                errors.append(f"{p}.attr: {{ dim: code, in: [codes] }} required")
            elif master is not None:
                opts = master["dims"].get(arg["dim"])
                if opts is None:
                    errors.append(f"{p}.attr: unknown dimension {arg['dim']}")
                else:
                    for o in arg["in"]:
                        if o not in opts:
                            errors.append(f"{p}.attr: unknown option {arg['dim']}.{o}")
        elif op == "legacySegmentLabel":
            if strict:
                errors.append(f"{p}.legacySegmentLabel: compatibility-only node; not allowed in published rules")
            elif not isinstance(arg, dict) or not isinstance(arg.get("in"), list):
                errors.append(f"{p}.legacySegmentLabel: {{ in: [labels] }} required")

    walk(rule, path, 0)
    return errors, warnings


def uses_schema(campaign) -> bool:
    return isinstance(campaign, dict) and ("eligibilityRule" in campaign or "rewardVariants" in campaign)


def validate_campaign(campaign, master: dict | None = None) -> dict:
    """Return {'status': 'legacy'|'valid'|'invalid', 'errors': [...], 'warnings': [...]}."""
    if not uses_schema(campaign):
        return {"status": "legacy", "errors": [], "warnings": []}
    errors: list[str] = []
    warnings: list[str] = []
    if "eligibilitySchemaVersion" not in campaign:
        errors.append("eligibilitySchemaVersion: missing (required when eligibilityRule/rewardVariants is present)")
    else:
        v = campaign["eligibilitySchemaVersion"]
        if not _is_int(v):
            errors.append(f"eligibilitySchemaVersion: malformed ({json.dumps(v)}); integer required")
        elif v not in SUPPORTED_VERSIONS:
            errors.append(f"eligibilitySchemaVersion: unsupported ({v}); supported: {', '.join(map(str, SUPPORTED_VERSIONS))}")
    if errors:  # unknown version: the content is not interpreted at all
        return {"status": "invalid", "errors": errors, "warnings": warnings}
    if "eligibilityRule" in campaign:
        e, w = check_rule(campaign["eligibilityRule"], master, "$.eligibilityRule", strict=True)
        errors += e; warnings += w
    if "rewardVariants" in campaign:
        vs = campaign["rewardVariants"]
        if not isinstance(vs, list) or not vs:
            errors.append("$.rewardVariants: non-empty array required")
        else:
            for i, v in enumerate(vs):
                p = f"$.rewardVariants[{i}]"
                if not isinstance(v, dict):
                    errors.append(f"{p}: object required"); continue
                if "when" not in v:
                    errors.append(f"{p}.when: required")
                else:
                    e, w = check_rule(v["when"], master, f"{p}.when", strict=True)
                    errors += e; warnings += w
                if not isinstance(v.get("rewardRule"), dict):
                    errors.append(f"{p}.rewardRule: object required")
    return {"status": "invalid" if errors else "valid", "errors": errors, "warnings": warnings}
