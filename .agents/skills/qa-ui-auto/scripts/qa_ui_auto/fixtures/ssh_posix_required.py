"""Require the explicit POSIX PTY service for portable terminal/SFTP workflows."""
from typing import Any

from .ssh_required import setup as probe


def setup(ctx: Any) -> None:
    probe(ctx, section_name="ssh_posix", password_env="QA_POSIX_SSH_PASSWORD")
