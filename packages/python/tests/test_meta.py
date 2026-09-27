"""One identity everywhere: Python metadata, pyproject.toml, and the Node.js package."""

from __future__ import annotations

import json
import re
import tomllib

import penge_passport_ph as pkg
from penge_passport_ph import _meta

from .conftest import REPO, TS_PACKAGE


def test_pyproject_matches_meta() -> None:
    project = tomllib.loads((REPO / "packages" / "python" / "pyproject.toml").read_text())[
        "project"
    ]
    assert project["name"] == _meta.NAME
    assert project["version"] == _meta.VERSION == pkg.__version__
    assert project["scripts"] == {
        _meta.NAME: "penge_passport_ph.cli:main",
        _meta.CLI_ALIAS: "penge_passport_ph.cli:main",
    }
    assert project["urls"]["Homepage"] == _meta.HOMEPAGE


def test_node_package_has_the_same_identity_and_version() -> None:
    meta_ts = (TS_PACKAGE / "src" / "meta.ts").read_text()
    ts = dict(re.findall(r"export const (\w+) = '([^']*)';", meta_ts))
    for key in (
        "DISPLAY_NAME",
        "NAME",
        "CLI_ALIAS",
        "VERSION",
        "HOMEPAGE",
        "REPOSITORY",
        "ENV_PREFIX",
    ):
        assert getattr(_meta, key) == ts[key], key
    package = json.loads((TS_PACKAGE / "package.json").read_text())
    assert package["version"] == _meta.VERSION


def test_user_agent() -> None:
    assert pkg.user_agent() == (
        f"penge-passport-ph/{pkg.VERSION} "
        "(+https://alphaexperiments.com/pengepassportph/; read-only availability checker)"
    )
    assert pkg.user_agent("me@example.com").endswith("; me@example.com)")
