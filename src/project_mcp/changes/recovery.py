"""Hash-based restart recovery that never overwrites unknown user content."""

from __future__ import annotations

from .executor import RecoveryRequired


def _observations(executor, transaction: dict) -> list[str]:
    values = []
    for item in transaction["files"]:
        current = executor._current_hash(executor._target(item["path"]))
        if current == item["after_sha256"]:
            values.append("after")
        elif current == item["before_sha256"]:
            values.append("before")
        else:
            values.append("unknown")
    return values


def _move_to_recovery(executor, current: dict, kind: str, reason: str) -> dict:
    if current["state"] == "recovery_required":
        return current
    executor.store.set_transaction_phase(current["change_id"], kind, "recovery_required")
    return executor.store.transition(
        executor.actor_id, executor.project_id, current["change_id"],
        expected_revision=current["revision"],
        expected_states={"applying", "reverting"}, new_state="recovery_required",
        transaction_kind=kind, blocked_reason=reason, error_code="RECOVERY_REQUIRED",
    )


def recover_transaction(executor, change_id: str, action: str) -> dict:
    if action not in {"verify", "rollback"}:
        raise ValueError("recovery action must be verify or rollback")
    current = executor.store.get(executor.actor_id, executor.project_id, change_id)
    if current["state"] not in {"applying", "reverting", "recovery_required"}:
        return current
    kind = executor.store.transaction_kind(executor.actor_id, executor.project_id, change_id)
    transaction = executor.store.transaction(change_id, kind)

    if action == "rollback":
        if not executor._try_rollback(transaction, kind):
            _move_to_recovery(executor, current, kind, "disk contains unknown user content")
            raise RecoveryRequired("RECOVERY_REQUIRED: rollback would overwrite unknown content")
        target_state = "rolled_back" if kind == "apply" else "applied"
        executor.store.set_transaction_phase(change_id, kind, "rolled_back")
        return executor.store.transition(
            executor.actor_id, executor.project_id, change_id,
            expected_revision=current["revision"],
            expected_states={current["state"]}, new_state=target_state,
            transaction_kind=kind,
        )

    observed = _observations(executor, transaction)
    if all(value == "after" for value in observed):
        target_state = "applied"
        phase = "complete" if kind == "apply" else "rolled_back"
    elif all(value == "before" for value in observed):
        target_state = "rolled_back" if kind == "apply" else "reverted"
        phase = "rolled_back" if kind == "apply" else "complete"
    else:
        return _move_to_recovery(
            executor, current, kind, "transaction is partial or contains unknown content",
        )
    executor.store.set_transaction_phase(change_id, kind, phase)
    return executor.store.transition(
        executor.actor_id, executor.project_id, change_id,
        expected_revision=current["revision"], expected_states={current["state"]},
        new_state=target_state, transaction_kind=kind,
    )
