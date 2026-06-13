import sys
from pathlib import Path

# Ensure the pipeline root is importable so `ingest`, `embed`, `publish` resolve in tests.
sys.path.insert(0, str(Path(__file__).parent))
