import asyncio

import pytest


@pytest.mark.asyncio
async def test_read_budget_rejects_only_after_queue_is_full_and_recovers_on_cancel():
    from project_mcp.runtime_limits import BusyError, RuntimeLimits

    limits = RuntimeLimits(read_concurrency=1, read_queue=1)
    release = asyncio.Event()
    active = asyncio.Event()

    async def hold_slot():
        async with limits.read.slot():
            active.set()
            await release.wait()

    holder = asyncio.create_task(hold_slot())
    await active.wait()
    queued = asyncio.create_task(limits.read.acquire())
    await asyncio.sleep(0)
    with pytest.raises(BusyError) as error:
        await limits.read.acquire()
    assert error.value.code == "RATE_LIMITED"

    queued.cancel()
    with pytest.raises(asyncio.CancelledError):
        await queued
    release.set()
    await holder
    await limits.read.acquire()
    limits.read.release()
    assert limits.read.active == 0
    assert limits.read.waiting == 0


@pytest.mark.asyncio
async def test_status_budget_is_independent_from_read_budget():
    from project_mcp.runtime_limits import RuntimeLimits

    limits = RuntimeLimits(read_concurrency=1, read_queue=0, status_concurrency=1)
    await limits.read.acquire()
    await limits.status.acquire()
    assert limits.read.active == 1
    assert limits.status.active == 1
    limits.status.release()
    limits.read.release()
