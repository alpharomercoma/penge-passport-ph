"""PengePassportPH canary, Python package: scrapes the same record as the Node.js
API canary through the Python package and checks the two agree.

    uv run --project packages/python python scripts/canary/python.py

Writes canary-results/python.{json,md} in the same format as report.mjs, so the
issue step picks it up. Settings: the same PENGE_PASSPORT_PH_* variables as
scripts/canary/config.mjs. Runbook: docs/canary.md.
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from penge_passport_ph import DISPLAY_NAME, ENV_PREFIX, VERSION, PengePassportPH

ROOT = Path(__file__).resolve().parents[2]
EXPECTED = json.loads((ROOT / "scripts" / "canary" / "expected.json").read_text())


def env(key: str) -> str | None:
    return os.environ.get(f"{ENV_PREFIX}{key}") or None


RESULTS = Path(env("RESULTS_DIR") or "canary-results")
SITE_ID = int(env("SITE_ID") or EXPECTED["canarySiteId"])
BASE_URL = env("BASE_URL") or "https://passport.gov.ph"
REPO = os.environ.get("GITHUB_REPOSITORY")
CONTACT = f"canary; {os.environ.get('GITHUB_SERVER_URL')}/{REPO}" if REPO else "canary"
ICON = {"pass": "✅", "fail": "❌", "warn": "⚠️", "skip": "⏭️"}


def cell(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", "<br>")


class Report:
    def __init__(self, id: str, title: str) -> None:
        self.id, self.title = id, title
        self.checks: list[dict[str, str]] = []
        self.started = datetime.now(UTC)
        RESULTS.mkdir(parents=True, exist_ok=True)

    def add(self, status: str, name: str, detail: str = "") -> None:
        self.checks.append({"status": status, "name": name, "detail": detail})
        line = f"{ICON[status]} {name}" + (f" - {detail}" if detail else "")
        print(line, file=sys.stderr if status == "fail" else sys.stdout, flush=True)
        if os.environ.get("GITHUB_ACTIONS") and status in ("fail", "warn"):
            level = "error" if status == "fail" else "warning"
            title = f"{DISPLAY_NAME} canary · {self.title}: {name}".replace(":", "%3A").replace(
                ",", "%2C"
            )
            print(f"::{level} title={title}::{detail.replace('%', '%25').replace(chr(10), '%0A')}")

    def check(self, name: str, fn: Callable[[], Any]) -> Any:
        try:
            value = fn()
        except Exception as err:
            self.add("fail", name, f"{type(err).__name__}: {err}")
            return None
        detail = value if isinstance(value, str) else (value or {}).get("detail", "")
        self.add("pass", name, detail)
        return value

    def finish(self) -> int:
        failed = [c for c in self.checks if c["status"] == "fail"]
        passed = sum(c["status"] == "pass" for c in self.checks)
        prefix = f"{DISPLAY_NAME} canary · {self.title}"
        headline = (
            f"❌ {prefix}: {len(failed)} of {len(self.checks)} checks FAILED"
            if failed
            else f"✅ {prefix}: all {passed} checks passed"
        )
        markdown = "\n".join(
            [f"## {headline}", "", "| | Check | Detail |", "|---|---|---|"]
            + [
                f"| {ICON[c['status']]} | {cell(c['name'])} | {cell(c['detail'])} |"
                for c in self.checks
            ]
            + ["", ""]
        )
        print(f"\n{headline}")
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a", encoding="utf-8") as f:
                f.write(markdown)
        (RESULTS / f"{self.id}.md").write_text(markdown, encoding="utf-8")
        (RESULTS / f"{self.id}.json").write_text(
            json.dumps(
                {
                    "id": self.id,
                    "title": self.title,
                    "startedAt": self.started.isoformat(),
                    "finishedAt": datetime.now(UTC).isoformat(),
                    "ok": not failed,
                    "checks": self.checks,
                },
                indent=2,
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        return 1 if failed else 0


def main() -> int:
    report = Report("python", "Python package")
    node_version = json.loads(
        (ROOT / "packages" / "penge-passport-ph" / "package.json").read_text()
    )["version"]

    def same_version() -> str:
        assert node_version == VERSION, f"Python {VERSION} vs Node {node_version}"
        return f"penge-passport-ph {VERSION} on Python {sys.version.split()[0]}"

    report.check("Python package is the same release as the Node package", same_version)
    penge = PengePassportPH(base_url=BASE_URL, contact=CONTACT)

    def countries() -> str:
        found = penge.countries(1)
        assert any(c.id == 1 and "philippines" in c.name.lower() for c in found), (
            "Philippines (id 1) missing"
        )
        return f"{len(found)} countries"

    report.check("Countries endpoint lists the Philippines (region 1)", countries)

    def sites() -> str:
        found = penge.sites()
        site = next((s for s in found if s.id == SITE_ID), None)
        assert site, f"site {SITE_ID} no longer listed"
        return f"{site.name}; {len(found)} sites"

    report.check(f"Sites endpoint lists canary site {SITE_ID}", sites)

    def availability_parses() -> dict[str, Any]:
        a = penge.availability(SITE_ID)
        return {"detail": f"{len(a.days)} published days, {len(a.available_dates)} open", "a": a}

    availability = report.check(f"Availability for site {SITE_ID} parses", availability_parses)

    record_file = RESULTS / "record.json"
    if not record_file.exists():
        report.add(
            "skip",
            "Agrees with the Node client",
            "the Node API canary saved no record to compare with",
        )
        return report.finish()
    record = json.loads(record_file.read_text())

    if availability:
        a = availability["a"]

        def same_published_dates() -> str:
            node = [d["date"] for d in record["days"]]
            python = [d.date for d in a.days]
            assert python == node, (
                f"Node {len(node)} dates, Python {len(python)}: {sorted(set(node) ^ set(python))}"
            )
            return f"{len(python)} dates identical"

        report.check("Same published dates as the Node client", same_published_dates)
        node_open = [d["date"] for d in record["days"] if d["available"]]
        if list(a.available_dates) == node_open:
            report.add("pass", "Same open dates as the Node client", f"{len(node_open)} open")
        else:
            report.add(
                "warn",
                "Same open dates as the Node client",
                "differ; slots were probably taken or released between the two runs",
            )

    date = record["timeSlots"]["date"]

    def same_slots() -> str:
        python = [(s.start, s.end) for s in penge.time_slots(SITE_ID, date)]
        node = [(s["start"], s["end"]) for s in record["timeSlots"]["slots"]]
        if python != node:
            diff = [
                f"Node {n[0]}-{n[1]} vs Python {p[0]}-{p[1]}"
                for n, p in zip(node, python, strict=False)
                if n != p
            ]
            if len(node) != len(python):
                diff.append(f"Node has {len(node)} slots, Python {len(python)}")
            raise AssertionError(f"{date}: " + "; ".join(diff))
        return f"{len(python)} slots on {date}"

    report.check("Same time slots as the Node client", same_slots)
    return report.finish()


if __name__ == "__main__":
    raise SystemExit(main())
