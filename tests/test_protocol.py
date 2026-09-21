import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[1]
FIXTURES = ROOT / "contracts" / "fixtures" / "service-info.json"


def test_service_contract_fixtures_follow_major_version_rule():
    from project_mcp.protocol import ServiceInfo, require_compatible_protocol

    cases = json.loads(FIXTURES.read_text(encoding="utf8"))
    compatible = ServiceInfo.model_validate(cases["compatible"])
    require_compatible_protocol(compatible.protocol_version)
    future = ServiceInfo.model_validate(cases["compatible_with_unknown"])
    require_compatible_protocol(future.protocol_version)
    with pytest.raises(ValueError, match="VERSION_INCOMPATIBLE"):
        require_compatible_protocol(cases["incompatible_major"]["protocol_version"])
    with pytest.raises(ValueError):
        ServiceInfo.model_validate(cases["missing_required"])


def test_generated_contracts_are_current():
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "generate_contracts.py"), "--check"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout
