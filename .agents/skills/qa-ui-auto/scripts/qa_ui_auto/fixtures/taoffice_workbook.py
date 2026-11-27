"""Provide the real QA workbook and its corresponding browser RPC fixture."""
import hashlib
import json


def fixtures(assets, values):
    data = (assets / "quarterly.xlsx").read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    totals = [
        (0, 0, "Product"), (0, 1, "Q4"), (0, 2, "Q5"), (1, 0, "Keyboard"),
        (1, 1, "12"), (1, 2, "24", "B2*2"), (2, 0, "Monitor"), (2, 1, "8"),
        (2, 2, "16", "B3*2"), (34, 1, "Next page"), (34, 12, "Beyond L"),
    ]
    inventory = [
        (0, 0, "Region"), (0, 1, "Available"), (1, 0, "上海"), (1, 1, "TRUE"),
        (1, 2, "2026-11-27 00:00:00"),
    ]

    def sheet(rows, columns, items):
        cells = []
        for row, column, value, *formula in items:
            cell = {"row": row, "column": column, "value": value}
            if items is totals and row == 0:
                cell["tableMetadata"] = True
            elif formula:
                cell["formula"] = formula[0]
            else:
                cell["editType"] = "number" if value.isdigit() else "text"
            cells.append(cell)
        return {"rows": rows, "columns": columns, "cells": cells}

    values["taoffice_workbook_sha"] = digest
    values["taoffice_workbook_model"] = json.dumps({
        "hash": digest, "sheets": {"Totals": sheet(35, 13, totals), "Inventory": sheet(2, 3, inventory)},
    }, ensure_ascii=False)
    return {"quarterly.xlsx": data, "broken.xlsx": b"This is not an Excel workbook."}
