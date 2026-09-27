"""Package identity. Mirrors src/meta.ts; tests/test_meta.py fails if they differ."""

#: The brand, as written in prose, titles and the logo.
DISPLAY_NAME = "PengePassportPH"
#: PyPI distribution, CLI command, repository, state directory and User-Agent product.
NAME = "penge-passport-ph"
#: Short CLI command installed alongside NAME.
CLI_ALIAS = "penge"
VERSION = "0.1.0"
#: A live page about the project: shown in the CLI help and the User-Agent.
HOMEPAGE = "https://alphaexperiments.com/pengepassportph/"
#: Source, issues and changelog. It must exist before a release is published.
REPOSITORY = "https://github.com/alpharomercoma/penge-passport-ph"
#: Prefix for every environment variable this package reads.
ENV_PREFIX = "PENGE_PASSPORT_PH_"
