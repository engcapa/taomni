"""Lifetime for a fixed inactive-module WAL fixture; never launches a host."""
from dataclasses import dataclass, field
import sqlite3

from ..steps import StepError


@dataclass
class ModuleBackupData:
    connection: sqlite3.Connection | None = None
    seen_jobs: set[str] = field(default_factory=set)

    def close(self):
        if self.connection is not None:
            self.connection.close()
            self.connection = None


def state(ctx) -> ModuleBackupData:
    owner = getattr(ctx, "fixture_context", None) or ctx
    data = getattr(owner, "module_backup_data", None)
    if not isinstance(data, ModuleBackupData):
        raise StepError("module_backup_probe requires the module_backup_data fixture")
    return data


def setup(ctx):
    ctx.module_backup_data = ModuleBackupData()


def teardown(ctx):
    state(ctx).close()
