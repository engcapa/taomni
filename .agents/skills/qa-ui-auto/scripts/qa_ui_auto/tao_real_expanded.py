"""Entry point for bounded opt-in commercial native scenarios."""
from .steps import StepError


def run(ctx, args):
    if not isinstance(args, dict) or set(args) != {"scenario"}:
        raise StepError("tao_real_provider_expanded expects scenario only")
    if args["scenario"] == "images":
        from .tao_real_images import run as probe
    elif args["scenario"] == "code":
        from .tao_real_code import run as probe
    elif args["scenario"] == "options":
        from .tao_real_options import run as probe
    elif args["scenario"] == "actions":
        from .tao_real_actions import run as probe
    elif args["scenario"] == "lifecycle":
        from .tao_real_lifecycle import run as probe
    elif args["scenario"] in {"persistence-prepare", "persistence-verify"}:
        from .tao_real_persistence import run as persistence
        return persistence(ctx, args["scenario"].split("-", 1)[1])
    elif args["scenario"] == "attachments":
        from .tao_real_attachments import run as probe
    elif args["scenario"] == "document-files":
        from .tao_real_documents_files import run as probe
    elif args["scenario"] == "archive":
        from .tao_real_archive import run as probe
    elif args["scenario"] == "concurrency":
        from .tao_real_concurrency import run as probe
    else:
        raise StepError("Unknown expanded real-provider scenario")
    return probe(ctx)
