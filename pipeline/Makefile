# DREAMREEL offline corpus pipeline.
# `make corpus` runs ingest -> download -> embed -> publish end to end.

OUT ?= out
PY  ?= python3

.PHONY: corpus ingest download embed publish test clean install install-embed

install:
	pip install -e .

install-embed:
	pip install -e '.[embed,publish]'

ingest:
	$(PY) -m ingest.run --out $(OUT)

# fetch + resize the real media named in candidates.jsonl -> $(OUT)/fetched.jsonl
download:
	$(PY) -m embed.download --candidates $(OUT)/candidates.jsonl --out $(OUT)

# build_manifest reads $(OUT)/fetched.jsonl (from the download step) for the real image assets.
embed:
	$(PY) -m embed.build_manifest --out $(OUT)

publish:
	$(PY) -m publish.run --out $(OUT)

# full corpus build (openverse + wellcome + archive + museums by default).
# Add UPLOAD=1 to push to R2 (requires R2_* env).
corpus: ingest download embed publish
ifeq ($(UPLOAD),1)
	$(PY) -m publish.run --out $(OUT) --upload
endif
	@echo "corpus built -> $(OUT)/manifest.json"

test:
	$(PY) -m pytest -q

clean:
	rm -rf $(OUT)/images $(OUT)/*.jsonl $(OUT)/*.json
