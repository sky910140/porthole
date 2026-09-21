"""Small independent concurrency budgets for project reads and status traffic."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager


class BusyError(RuntimeError):
    code = "RATE_LIMITED"


class AsyncBudget:
    def __init__(self, concurrency: int, queue_size: int) -> None:
        if concurrency < 1 or queue_size < 0:
            raise ValueError("Invalid runtime budget")
        self._semaphore = asyncio.Semaphore(concurrency)
        self.max_queue = queue_size
        self.active = 0
        self.waiting = 0

    async def acquire(self) -> None:
        queued = self._semaphore.locked()
        if queued and self.waiting >= self.max_queue:
            raise BusyError("RATE_LIMITED: service is busy; retry later")
        if queued:
            self.waiting += 1
        try:
            await self._semaphore.acquire()
        finally:
            if queued:
                self.waiting -= 1
        self.active += 1

    def release(self) -> None:
        if self.active < 1:
            raise RuntimeError("Runtime budget released without an active slot")
        self.active -= 1
        self._semaphore.release()

    @asynccontextmanager
    async def slot(self):
        await self.acquire()
        try:
            yield
        finally:
            self.release()


class RuntimeLimits:
    def __init__(
        self,
        *,
        read_concurrency: int = 4,
        read_queue: int = 32,
        status_concurrency: int = 2,
    ) -> None:
        self.read = AsyncBudget(read_concurrency, read_queue)
        self.status = AsyncBudget(status_concurrency, 4)
