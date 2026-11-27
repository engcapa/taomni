"""Solid LZMA2 archive produced with py7zr from the fixture's text and PNG."""
import base64


def archive() -> bytes:
    return base64.b64decode(
        "N3q8ryccAARcQMiH7wAAAAAAAAAWAAAAAAAAABw4iA8BAGlGaWxlIG9wZW4gb3JpZ2luYWwKU2Vjb25kIGxpbmUK5Lit"
        "5paHColQTkcNChoKAAAADUlIRFIAAAABAAAAAQgEAAAAtRwMAgAAAAtJREFUeNpj/P8fAAMDAgDvoqdbAAAAAElFTkSu"
        "QmCCAOAAlAB5XQAAgTMHrg/URIl9QMCQ0v90oc2Kfr12j/3zH3SrHaXUfWgIyOSJADOFtleIQKYAF1hSz2mePjB8nlOl"
        "C/sJDgCYmV8a+o/pWHOZchYgLco5QwGjlDk5PYVmbCbsbZUMO/1BoQU4TVRwstghRPqilOalqkM+lingAAAAABcGbgEJ"
        "gIEABwsBAAEhIQEYDICVAAA="
    )
