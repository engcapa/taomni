"""Lifetime for a fixed inactive-module WAL fixture; never launches a host."""
def setup(ctx):
    ctx._module_backup_connection = None


def teardown(ctx):
    connection = getattr(ctx, "_module_backup_connection", None)
    if connection is not None:
        connection.close()
        ctx._module_backup_connection = None
