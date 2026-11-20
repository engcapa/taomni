"""Inspect saved/downloaded Mermaid draw.io XML independently of the renderer."""
import math
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from .steps import StepError
from .drawio_connection_quality import inspect_sequence_connections


def inspect_drawio(path):
    data = Path(path).read_bytes()
    if len(data) > 20 * 1024 * 1024 or re.search(rb"<!DOCTYPE|<!ENTITY", data, re.I):
        raise StepError("draw.io export has unsafe XML or exceeds the file limit")
    try:
        document = ET.fromstring(data)
    except ET.ParseError as exc:
        raise StepError("draw.io export is not valid XML") from exc
    models = document.findall("./diagram/mxGraphModel")
    if document.tag != "mxfile" or not models:
        raise StepError("draw.io export has no editable graph sheets")
    result = dict(sheets=len(models), independentCells=0, curvedEdges=0, straightEdges=0, sequences=0, sources=[], checkedSequenceEndpoints=0, maximumEndpointError=0, maximumCurveControlPoints=0)
    for model in models:
        root = model.find("root")
        if root is None:
            raise StepError("draw.io export lost the graph root")
        cells = {}
        for item in root:
            cell = item if item.tag == "mxCell" else item.find("mxCell")
            if cell is None:
                raise StepError("draw.io graph contains a non-cell element")
            identity = item.get("id") or cell.get("id")
            if not identity or identity in cells:
                raise StepError("draw.io cells have missing/duplicate identities")
            cells[identity] = cell
        sources = [(item.get("id"), item.get("mermaidSource", "")) for item in root if item.get("mermaidSource")]
        result["sources"].extend(source for _, source in sources)
        if not sources:
            continue  # Full-document narrative/table sheet has no Mermaid.
        for identity, cell in cells.items():
            if cell.get("vertex") != "1" and cell.get("edge") != "1":
                continue
            # Markdown tables deliberately retain a table parent. Mermaid
            # elements must be independent, including subgraph outlines.
            if not re.match(r"(?:mermaid|diagram-\d+)-", identity):
                continue
            style = dict(part.split("=", 1) for part in cell.get("style", "").split(";") if "=" in part)
            if cell.get("parent") != "1" or re.search(r"(?:^|;)group(?:;|$)", cell.get("style", "")) or style.get("shape") == "image":
                raise StepError("Mermaid export is grouped, flattened or has an unexpected parent")
            result["independentCells"] += 1
            geometry = cell.find("mxGeometry")
            if geometry is None:
                raise StepError("Editable draw.io cell has no geometry")
            for element in geometry.iter():
                for key in ("x", "y", "width", "height"):
                    if element.get(key) is not None and not math.isfinite(float(element.get(key))):
                        raise StepError("draw.io export has non-finite geometry")
            if cell.get("edge") != "1":
                continue
            if geometry.get("relative") != "1":
                raise StepError("Editable edge lost relative geometry")
            for terminal in ("source", "target"):
                if cell.get(terminal) and cell.get(terminal) not in cells:
                    raise StepError("draw.io edge refers to a missing terminal")
            if style.get("edgeStyle") != "none":
                raise StepError("Mermaid connector was rerouted instead of retaining its original path")
            if geometry.find("mxPoint[@as='sourcePoint']") is None or geometry.find("mxPoint[@as='targetPoint']") is None:
                raise StepError("Mermaid connector lost its original endpoints")
            if style.get("curved") == "1":
                controls = len(geometry.findall("Array[@as='points']/mxPoint"))
                if controls > 12 or style.get("shape", "connector") != "connector":
                    raise StepError("Mermaid curve is not a compact native draw.io connector")
                result["maximumCurveControlPoints"] = max(result["maximumCurveControlPoints"], controls)
            result["curvedEdges" if style.get("curved") == "1" else "straightEdges"] += 1
        connections = inspect_sequence_connections(cells)
        result["checkedSequenceEndpoints"] += connections["checkedSequenceEndpoints"]
        result["maximumEndpointError"] = max(result["maximumEndpointError"], connections["maximumEndpointError"])
        for first_id, source in sources:
            if "sequenceDiagram" in source:
                result["sequences"] += 1
                prefix = first_id.split("-activation-")[0]
                sequence = [cell for identity, cell in cells.items() if identity.startswith(prefix + "-")]
                messages = [cell for cell in sequence if cell.get("taomniKind") == "sequence-message"]
                if len(messages) != 9 or sum(cell.get("from") == cell.get("to") for cell in messages) != 3:
                    raise StepError("Agent sequence lost messages or editable self-calls")
                for kind, expected in (("sequence-lifeline", 4), ("sequence-activation", 2), ("sequence-fragment", 4)):
                    if sum(cell.get("taomniKind") == kind for cell in sequence) != expected:
                        raise StepError("Agent sequence lost editable " + kind)
                if not any("dashed=1;" in cell.get("style", "") for cell in messages) or not any("curved=1;" in cell.get("style", "") for cell in messages):
                    raise StepError("Agent sequence lost dotted returns or curved self-calls")
            elif re.search(r"curve:\s*(?:linear|stepBefore)", source):
                prefix = re.sub(r"-node-\d+$", "", first_id)
                edges = [cell for identity, cell in cells.items() if identity.startswith(prefix + "-edge-")]
                if not edges or any("curved=0;" not in cell.get("style", "") for cell in edges):
                    raise StepError("Straight/stepped Mermaid connectors became curves")
                if "stepBefore" in source and not any(cell.findall("mxGeometry/Array/mxPoint") for cell in edges):
                    raise StepError("Stepped Mermaid export lost its corners")
    if not result["sources"] or not result["independentCells"]:
        raise StepError("draw.io export has no independent Mermaid cells or source metadata")
    return result
