from project_mcp.policy import ProjectPolicy


def test_policy_defaults_to_read_only_and_apply_is_separate():
    policy = ProjectPolicy()
    assert policy.allows("src/app.py", "read")
    assert not policy.allows("src/app.py", "propose")
    assert not policy.allows("src/app.py", "apply_local")

    proposal = ProjectPolicy(mode="propose")
    assert proposal.allows("src/app.py", "propose")
    assert not proposal.allows("src/app.py", "apply_local")
    enabled = ProjectPolicy(mode="propose", apply_local_enabled=True)
    assert enabled.allows("src/app.py", "apply_local")


def test_pause_and_rule_change_invalidate_existing_policy_version():
    original = ProjectPolicy(mode="propose", apply_local_enabled=True)
    paused = ProjectPolicy(mode="propose", apply_local_enabled=True, paused=True)
    changed = ProjectPolicy(mode="propose", exclude_paths=["src/private/**"])
    assert not paused.allows("src/app.py", "read")
    assert original.version != paused.version
    assert original.version != changed.version
    assert not changed.allows("src/private/key.py", "read")


def test_secret_and_case_aliases_are_denied_consistently():
    policy = ProjectPolicy()
    for path in (".ENV", "Config/LOCAL.JSON", "nested/Client.KEY", "TOKENS.JSON"):
        assert not policy.allows(path, "read")
        assert policy.exclusion_reason(path) == "sensitive_path"


def test_repository_suggestions_can_only_reduce_scope():
    policy = ProjectPolicy(
        exclude_paths=["private/**"],
        repository_rules={"include": ["private/**", ".env"], "exclude": ["generated/**"]},
    )
    assert not policy.allows("private/a.txt", "read")
    assert not policy.allows("generated/a.txt", "read")
    assert policy.allows("src/a.txt", "read")


def test_policy_rejects_unsafe_configured_patterns():
    for value in ("../outside", "/absolute", r"C:\\outside", "file.txt:stream"):
        try:
            ProjectPolicy(exclude_paths=[value])
        except ValueError:
            pass
        else:
            raise AssertionError(f"unsafe pattern accepted: {value}")
