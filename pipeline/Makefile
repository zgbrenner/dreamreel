# DREAMREEL offline corpus pipeline.
# `make corpus` runs ingest -> embed -> publish end to end.

OUT ?= out
PY  ?= python3

.PHONY: corpus ingest embed publish test clean install install-embed

install:
	pip install -e .

install-embed:
	pip install -e '.[embed,publish]'

ingest:
	$(PY) -m ingest.run --out $(OUT)

# embed depends on a download step for images; build_manifest reads $(OUT)/fetched.jsonl if present.
embed:
	$(PY) -m embed.build_manifest --out $(OUT)

publish:
	$(PY) -m publish.run --out $(OUT)

# full corpus build. Add UPLOAD=1 to push to R2 (requires R2_* env).
corpus: ingest embed publish
ifeq ($(UPLOAD),1)
	$(PY) -m publish.run --out $(OUT) --upload
endif
	@echo "corpus built -> $(OUT)/manifest.json"

test:
	$(PY) -m pytest -q

clean:
	rm -rf $(OUT)/images $(OUT)/*.jsonl $(OUT)/*.json
