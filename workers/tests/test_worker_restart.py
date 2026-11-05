import argparse
import asyncio
import contextlib
import os
import signal

import pytest
from procrastinate.exceptions import ConnectorException
from psycopg_pool import PoolTimeout

from bl_worker import cli, runtime
from bl_worker.jobs import app


class FakeRuntime:
    closed = 0

    def close(self):
        FakeRuntime.closed += 1


async def wait_for_stop_signal(**_kwargs):
    os.kill(os.getpid(), signal.SIGTERM)
    await asyncio.Event().wait()


@pytest.fixture
def worker(monkeypatch):
    runs = []
    sleeps = []

    @contextlib.asynccontextmanager
    async def open_async():
        yield app

    monkeypatch.setattr(cli, "load_settings", lambda: argparse.Namespace(database_url="x"))
    monkeypatch.setattr(runtime, "build_runtime", lambda *_a, **_k: FakeRuntime())
    monkeypatch.setattr(app, "replace_connector", lambda _c: contextlib.nullcontext())
    monkeypatch.setattr(app, "open_async", open_async)
    monkeypatch.setattr("time.sleep", sleeps.append)

    def run(behaviours, until_idle=False):
        it = iter(behaviours)

        async def run_worker_async(**kwargs):
            runs.append(kwargs)
            await next(it)(**kwargs)

        monkeypatch.setattr(app, "run_worker_async", run_worker_async)
        FakeRuntime.closed = 0
        cli.cmd_worker(argparse.Namespace(concurrency=1, until_idle=until_idle))
        return runs, sleeps

    return run


async def stops_on_its_own(**_kwargs):
    return None


async def loses_the_database(**_kwargs):
    raise ConnectorException


def test_a_worker_that_stops_on_its_own_is_restarted(worker):
    runs, sleeps = worker([stops_on_its_own, wait_for_stop_signal])
    assert len(runs) == 2
    assert sleeps == [2.0]
    assert FakeRuntime.closed == 2


def test_a_lost_database_restarts_the_worker(worker):
    runs, sleeps = worker([loses_the_database, loses_the_database, wait_for_stop_signal])
    assert len(runs) == 3
    assert sleeps == [2.0, 4.0]


def test_a_stop_signal_ends_the_worker(worker):
    runs, sleeps = worker([wait_for_stop_signal])
    assert len(runs) == 1
    assert sleeps == []
    assert runs[0]["install_signal_handlers"] is False


def test_a_pool_that_cannot_open_restarts_the_worker(worker):
    async def pool_timeout(**_kwargs):
        raise PoolTimeout("pool initialization incomplete after 30.0 sec")

    runs, sleeps = worker([pool_timeout, wait_for_stop_signal])
    assert len(runs) == 2
    assert sleeps == [2.0]


def test_until_idle_runs_once_and_lets_errors_through(worker):
    runs, _ = worker([stops_on_its_own], until_idle=True)
    assert len(runs) == 1
    with pytest.raises(ConnectorException):
        worker([loses_the_database], until_idle=True)
