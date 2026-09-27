"""Node.js and Python processes on one machine share one rate limit.

Runs the built Node package (../dist) and this package at the same time against
one state file, with real time, and checks every dispatch is at least 2 s from
the previous one, whichever language sent it."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from itertools import pairwise
from pathlib import Path

import pytest

from .conftest import TS_PACKAGE

DIST = TS_PACKAGE / "dist" / "rate-limit.js"
pytestmark = [
    pytest.mark.interop,
    pytest.mark.skipif(
        shutil.which("node") is None or not DIST.exists(), reason="needs node and npm run build"
    ),
]

NODE = """
import { FileStore, HostGate } from %(dist)s;
const gate = new HostGate(() => 0, new FileStore(process.argv[1]));
const opts = { minIntervalMs: 2000, maxRequestsPerHour: 600, maxWaitMs: 120000 };
const times = [];
for (let i = 0; i < 3; i++) {
  await gate.run(opts, async (report) => { times.push(Date.now()); report({ ok: true }); });
}
console.log(JSON.stringify(times));
"""

PYTHON = """
import json, sys, time
from penge_passport_ph.rate_limit import FileStore, GateOptions, HostGate, Outcome
gate = HostGate(FileStore(sys.argv[1]), random=lambda: 0.0)
opts = GateOptions(min_interval=2.0, max_requests_per_hour=600, max_wait=120.0)
times = []
for _ in range(3):
    def task(report):
        times.append(time.time() * 1000)
        report(Outcome(ok=True))
    gate.run(opts, task)
print(json.dumps(times))
"""


def test_node_and_python_share_one_spacing(tmp_path: Path) -> None:
    state = str(tmp_path / "passport.gov.ph.json")
    node = subprocess.Popen(
        ["node", "--input-type=module", "-e", NODE % {"dist": json.dumps(DIST.as_uri())}, state],
        stdout=subprocess.PIPE,
        text=True,
    )
    py = subprocess.Popen([sys.executable, "-c", PYTHON, state], stdout=subprocess.PIPE, text=True)
    node_out, _ = node.communicate(timeout=60)
    py_out, _ = py.communicate(timeout=60)
    assert node.returncode == 0 and py.returncode == 0
    dispatches = sorted(
        [("node", t) for t in json.loads(node_out)] + [("python", t) for t in json.loads(py_out)],
        key=lambda d: d[1],
    )
    assert len(dispatches) == 6
    assert {who for who, _ in dispatches} == {"node", "python"}
    # Each language records its dispatch decisions in the shared file, and that record
    # is what the spacing governs. (The tasks' own timestamps are taken a moment later,
    # and on a busy machine that moment varies by tens of milliseconds.)
    decided = sorted(json.loads(Path(state).read_text())["dispatched"])
    assert len(decided) == 6
    assert min(b - a for a, b in pairwise(decided)) >= 2000 - 1, decided
