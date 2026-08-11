PYTHON ?= python
PORT ?= 8000

.PHONY: help normalize validate build-all test serve fetch-ijcai embed-ijcai

help:
	@echo "Targets:"
	@echo "  make normalize    - rebuild normalized conference datasets"
	@echo "  make validate     - validate canonical datasets"
	@echo "  make build-all    - build all static conference sites"
	@echo "  make test         - run contract tests"
	@echo "  make serve        - preview docs/ at http://localhost:$(PORT)/docs/"
	@echo "  make fetch-ijcai  - refresh the pinned IJCAI HTML snapshot"
	@echo "  make embed-ijcai  - regenerate IJCAI SPECTER2 embeddings"

normalize:
	$(PYTHON) -m src.pipeline.cli normalize eacl-2026
	$(PYTHON) -m src.pipeline.cli normalize ijcai-2026

validate:
	$(PYTHON) -m src.pipeline.cli validate eacl-2026
	$(PYTHON) -m src.pipeline.cli validate ijcai-2026

build-all: validate
	$(PYTHON) -m src.pipeline.build

test:
	$(PYTHON) -m unittest discover -s tests -p "test_*.py" -v

serve:
	$(PYTHON) -m http.server $(PORT)

fetch-ijcai:
	$(PYTHON) -m src.pipeline.cli fetch ijcai-2026

embed-ijcai:
	$(PYTHON) scripts/compute_embeddings.py ijcai-2026 --device auto
