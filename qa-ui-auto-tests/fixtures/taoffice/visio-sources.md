# Visio QA fixtures

`visio-routing.vsdx` contains the Routing overview and Delivery details pages. Both pages contain a connector between two labeled rectangles and contain the word Routing. Each page has unique text so the test can check navigation, search, and the exported page independently. Regenerate it with `python qa-ui-auto-tests/fixtures/taoffice/visio-build-routing.py`.

`visio-legacy.vsd` is `Visio11FormatLine.vsd` from the libvisio 0.1.12 test corpus. It exercises line shapes and end markers in a binary Microsoft Visio 11 drawing. The upstream source archive includes the original fixture and the MPL 2.0 license. [libvisio 0.1.12 source archive](https://dev-www.libreoffice.org/src/libvisio/libvisio-0.1.12.tar.xz)

The file-open fixture creates `visio-damaged.vsdx` with invalid document bytes for the preview recovery case.
